// Runs a labeled prompt set through a MoE model, records which experts each domain routes to into
// WeightStream expert sheets, then estimates what domain-aware preloading would buy:
//  - how similar the domains' expert usage is,
//  - whether the domain can be recognized from the prompt alone (before generation),
//  - the share of expert uses a preloaded set of the RAM budget would cover (domain, global, random).
// Every estimate is leave-one-out: the prompt being scored never contributes to the profile scoring it.
#include "WeightStream/ExpertSheets.h"
#include "WeightStream/ExpertStore.h"
#include "WeightStream/GGUFReader.h"

#include "ggml-cpu.h"
#include "ggml.h"
#include "llama-ext.h"
#include "llama.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <numeric>
#include <string>
#include <vector>

namespace {

struct PromptCase {
    std::string domain;
    std::string text;
    std::vector<std::uint32_t> prefill;  // [layer * n_expert + expert] uses while reading the prompt
    std::vector<std::uint32_t> all;      // prompt + generation
};

struct Recorder {
    ws::ExpertSheets* sheets = nullptr;
    int domain = -1;
    int n_expert = 0;
    PromptCase* current = nullptr;
    bool in_prefill = false;
};

void observe(void* user, int32_t il, const int32_t* ids, size_t n_ids) {
    auto* r = static_cast<Recorder*>(user);
    if (r->current == nullptr) {
        return;
    }
    r->sheets->record(r->domain, il, ids, n_ids);
    for (size_t i = 0; i < n_ids; ++i) {
        const std::size_t k = static_cast<std::size_t>(il) * static_cast<std::size_t>(r->n_expert) + static_cast<std::size_t>(ids[i]);
        ++r->current->all[k];
        if (r->in_prefill) {
            ++r->current->prefill[k];
        }
    }
}

struct ExpertSource {
    ws::ExpertStore store;
    std::vector<ws::ExpertStore::Request> requests;
};

bool serve_experts(void* user, llama_moe_expert_read* reads, size_t n_reads) {
    auto* src = static_cast<ExpertSource*>(user);
    src->requests.resize(n_reads);
    for (size_t i = 0; i < n_reads; ++i) {
        src->requests[i] = {reads[i].tensor->name, reads[i].expert, static_cast<std::size_t>(reads[i].tensor->nb[2]), nullptr};
    }
    if (!src->store.fetch(src->requests.data(), n_reads)) {
        return false;
    }
    for (size_t i = 0; i < n_reads; ++i) {
        reads[i].data = src->requests[i].data;
    }
    return true;
}

void log_quiet(ggml_log_level level, const char* text, void*) {
    if (level >= GGML_LOG_LEVEL_WARN || std::strstr(text, "llama_moe_cache:") != nullptr) {
        std::fputs(text, stderr);
    }
}

using Counts = std::vector<double>;

void add_into(Counts& acc, const std::vector<std::uint32_t>& v) {
    for (std::size_t i = 0; i < v.size(); ++i) {
        acc[i] += v[i];
    }
}

double cosine(const Counts& a, const Counts& b) {
    double dot = 0, na = 0, nb = 0;
    for (std::size_t i = 0; i < a.size(); ++i) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return (na > 0 && nb > 0) ? dot / std::sqrt(na * nb) : 0.0;
}

// share of `uses` that falls in the k most used experts of `profile`
double coverage(const Counts& profile, const std::vector<std::uint32_t>& uses, std::size_t k) {
    std::vector<std::size_t> idx(profile.size());
    std::iota(idx.begin(), idx.end(), std::size_t{0});
    k = std::min(k, idx.size());
    std::nth_element(idx.begin(), idx.begin() + static_cast<std::ptrdiff_t>(k), idx.end(),
                     [&](std::size_t a, std::size_t b) { return profile[a] > profile[b]; });
    double hit = 0, total = 0;
    for (std::size_t i = 0; i < k; ++i) {
        hit += uses[idx[i]];
    }
    for (std::uint32_t u : uses) {
        total += u;
    }
    return total > 0 ? hit / total : 0.0;
}

std::vector<std::uint32_t> minus(const std::vector<std::uint32_t>& a, const std::vector<std::uint32_t>& b) {
    std::vector<std::uint32_t> out(a.size());
    for (std::size_t i = 0; i < a.size(); ++i) {
        out[i] = a[i] - b[i];
    }
    return out;
}

void print_usage() {
    std::cerr << "Usage: ws_expert_profile -m model.gguf --prompts file.tsv [--sheets out.wssheets] [--report out.csv]\n"
                 "                         [-n N] [--cache-mib N] [--ws-ram-mib N] [--budget-mib N] [--ubatch N]\n";
}

}  // namespace

int main(int argc, char** argv) {
    std::string model_path, prompts_path, sheets_path, report_path;
    int n_predict = 48;
    int n_ubatch = 32;
    std::size_t cache_mib = 7500;
    std::size_t ws_ram_mib = 12288;
    std::size_t budget_mib = 0;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : std::string(); };
        if (arg == "-m") model_path = next();
        else if (arg == "--prompts") prompts_path = next();
        else if (arg == "--sheets") sheets_path = next();
        else if (arg == "--report") report_path = next();
        else if (arg == "-n") n_predict = std::stoi(next());
        else if (arg == "--ubatch") n_ubatch = std::stoi(next());
        else if (arg == "--cache-mib") cache_mib = std::stoull(next());
        else if (arg == "--ws-ram-mib") ws_ram_mib = std::stoull(next());
        else if (arg == "--budget-mib") budget_mib = std::stoull(next());
        else { print_usage(); return 1; }
    }
    if (model_path.empty() || prompts_path.empty()) {
        print_usage();
        return 1;
    }
    if (budget_mib == 0) {
        budget_mib = ws_ram_mib;
    }

    std::vector<PromptCase> cases;
    {
        std::ifstream in(prompts_path, std::ios::binary);
        std::string line;
        while (std::getline(in, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            const auto tab = line.find('\t');
            if (tab == std::string::npos || line.empty() || line[0] == '#') continue;
            cases.push_back({line.substr(0, tab), line.substr(tab + 1), {}, {}});
        }
    }
    if (cases.empty()) {
        std::cerr << "no prompts in " << prompts_path << '\n';
        return 1;
    }

    // average bytes of one expert across its gate/up/down tensors, to turn the RAM budget into an expert count
    double expert_bytes = 0;
    {
        ws::GGUFReader reader(model_path);
        std::uint64_t exps_bytes = 0, n_slices = 0;
        for (const auto& t : reader.tensors()) {
            if (t.name.find("_exps") != std::string::npos && t.dimensions.size() == 3) {
                exps_bytes += t.size;
                n_slices += t.dimensions[2];
            }
        }
        expert_bytes = n_slices ? 3.0 * static_cast<double>(exps_bytes) / static_cast<double>(n_slices) : 0.0;
    }

    llama_log_set(log_quiet, nullptr);
    ggml_backend_load_all();

    ExpertSource source;
    if (ws_ram_mib > 0) {
        if (!source.store.open(model_path, ws_ram_mib * 1024 * 1024)) {
            std::cerr << "ExpertStore: " << source.store.last_error() << '\n';
            return 1;
        }
        llama_moe_set_expert_source(serve_experts, &source);
    }

    llama_model_tensor_buft_override overrides[] = {
        {"\\.ffn_(up|down|gate|gate_up)_(ch|)exps", ggml_backend_cpu_buffer_type()},
        {nullptr, nullptr},
    };
    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = 999;
    mp.tensor_buft_overrides = overrides;
    llama_model* model = llama_model_load_from_file(model_path.c_str(), mp);
    if (!model) {
        std::cerr << "model load failed\n";
        return 1;
    }
    const int n_layer = llama_model_n_layer(model);
    const int n_expert = llama_model_n_expert(model);
    const std::size_t n_flat = static_cast<std::size_t>(n_layer) * static_cast<std::size_t>(n_expert);

    char desc[256] = {};
    llama_model_desc(model, desc, sizeof(desc));
    ws::ExpertSheets sheets;
    if (sheets_path.empty() || !sheets.load(sheets_path) || sheets.n_layer() != n_layer || sheets.n_expert() != n_expert) {
        sheets.init(desc, n_layer, n_expert);
    }

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = 4096;
    cp.n_batch = 512;
    cp.n_ubatch = static_cast<uint32_t>(n_ubatch);
    cp.moe_cache_size = cache_mib * 1024 * 1024;
    llama_context* ctx = llama_init_from_model(model, cp);
    if (!ctx) {
        std::cerr << "context init failed\n";
        return 1;
    }

    Recorder rec;
    rec.sheets = &sheets;
    rec.n_expert = n_expert;
    llama_moe_set_expert_observer(observe, &rec);

    const llama_vocab* vocab = llama_model_get_vocab(model);
    const char* tmpl = llama_model_chat_template(model, nullptr);
    llama_sampler* smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(smpl, llama_sampler_init_greedy());

    for (std::size_t ci = 0; ci < cases.size(); ++ci) {
        PromptCase& pc = cases[ci];
        pc.prefill.assign(n_flat, 0);
        pc.all.assign(n_flat, 0);
        rec.domain = sheets.domain_id(pc.domain);
        rec.current = &pc;

        std::string formatted = pc.text;
        if (tmpl) {
            llama_chat_message msg{"user", pc.text.c_str()};
            std::vector<char> buf(pc.text.size() * 2 + 4096);
            const int32_t need = llama_chat_apply_template(tmpl, &msg, 1, true, buf.data(), static_cast<int32_t>(buf.size()));
            if (need > 0 && need <= static_cast<int32_t>(buf.size())) formatted.assign(buf.data(), static_cast<std::size_t>(need));
        }
        const int n_prompt = -llama_tokenize(vocab, formatted.c_str(), static_cast<int32_t>(formatted.size()), nullptr, 0, true, true);
        std::vector<llama_token> toks(static_cast<std::size_t>(n_prompt));
        llama_tokenize(vocab, formatted.c_str(), static_cast<int32_t>(formatted.size()), toks.data(), n_prompt, true, true);

        llama_memory_clear(llama_get_memory(ctx), true);
        rec.in_prefill = true;
        const auto t0 = std::chrono::steady_clock::now();
        if (llama_decode(ctx, llama_batch_get_one(toks.data(), n_prompt))) {
            std::cerr << "prompt decode failed\n";
            return 1;
        }
        const double pp_s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        rec.in_prefill = false;

        int n_gen = 0;
        const auto t1 = std::chrono::steady_clock::now();
        for (; n_gen < n_predict; ++n_gen) {
            llama_token id = llama_sampler_sample(smpl, ctx, -1);
            if (llama_vocab_is_eog(vocab, id)) break;
            if (llama_decode(ctx, llama_batch_get_one(&id, 1))) break;
        }
        const double tg_s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t1).count();
        std::fprintf(stderr, "[%2zu/%zu] %-10s prompt %3d tok %5.2f tok/s | gen %3d tok %5.2f tok/s\n", ci + 1, cases.size(),
                     pc.domain.c_str(), n_prompt, n_prompt / pp_s, n_gen, n_gen > 0 ? n_gen / tg_s : 0.0);
        rec.current = nullptr;
    }
    llama_moe_set_expert_observer(nullptr, nullptr);

    if (!sheets_path.empty() && !sheets.save(sheets_path)) std::cerr << "cannot save " << sheets_path << '\n';
    if (!report_path.empty() && !sheets.write_report(report_path)) std::cerr << "cannot write " << report_path << '\n';

    // ---- analysis ----
    std::vector<std::string> domains;
    for (const auto& pc : cases) {
        if (std::find(domains.begin(), domains.end(), pc.domain) == domains.end()) domains.push_back(pc.domain);
    }
    const std::size_t k = expert_bytes > 0 ? static_cast<std::size_t>(static_cast<double>(budget_mib) * 1024.0 * 1024.0 / expert_bytes) : 0;
    std::printf("\n=== %d layers x %d experts, budget %zu MiB = %zu experts (%.1f%% of all, %.2f MiB each) ===\n",
                n_layer, n_expert, budget_mib, k, 100.0 * static_cast<double>(k) / static_cast<double>(n_flat), expert_bytes / (1024.0 * 1024.0));

    std::printf("\nDomain similarity (cosine of expert usage):\n%-11s", "");
    std::vector<Counts> dom_total(domains.size(), Counts(n_flat, 0.0));
    for (const auto& pc : cases) {
        add_into(dom_total[static_cast<std::size_t>(std::find(domains.begin(), domains.end(), pc.domain) - domains.begin())], pc.all);
    }
    for (const auto& d : domains) std::printf("%11s", d.c_str());
    std::printf("\n");
    for (std::size_t a = 0; a < domains.size(); ++a) {
        std::printf("%-11s", domains[a].c_str());
        for (std::size_t b = 0; b < domains.size(); ++b) std::printf("%11.3f", cosine(dom_total[a], dom_total[b]));
        std::printf("\n");
    }

    struct Row { double domain = 0, global = 0, oracle = 0, detected = 0; int correct = 0, n = 0; };
    std::map<std::string, Row> rows;
    const double random_cov = static_cast<double>(k) / static_cast<double>(n_flat);
    for (std::size_t p = 0; p < cases.size(); ++p) {
        const PromptCase& pc = cases[p];
        Counts global(n_flat, 0.0);
        std::vector<Counts> per_dom(domains.size(), Counts(n_flat, 0.0));
        for (std::size_t q = 0; q < cases.size(); ++q) {
            if (q == p) continue;
            add_into(global, cases[q].all);
            add_into(per_dom[static_cast<std::size_t>(std::find(domains.begin(), domains.end(), cases[q].domain) - domains.begin())], cases[q].all);
        }
        const std::size_t own = static_cast<std::size_t>(std::find(domains.begin(), domains.end(), pc.domain) - domains.begin());

        // recognize the domain from the prompt's own routing, before any token is generated
        Counts fp(pc.prefill.begin(), pc.prefill.end());
        std::size_t best = 0;
        double best_sim = -1;
        for (std::size_t d = 0; d < domains.size(); ++d) {
            const double s = cosine(fp, per_dom[d]);
            if (s > best_sim) { best_sim = s; best = d; }
        }

        // what generation would hit if the preload were chosen after reading the prompt
        const std::vector<std::uint32_t> gen = minus(pc.all, pc.prefill);
        Row& r = rows[pc.domain];
        r.domain += coverage(per_dom[own], gen, k);
        r.global += coverage(global, gen, k);
        r.detected += coverage(per_dom[best], gen, k);
        Counts self(gen.begin(), gen.end());
        r.oracle += coverage(self, gen, k);
        r.correct += best == own ? 1 : 0;
        r.n += 1;
    }

    std::printf("\nShare of generated-token expert uses covered by a preloaded set of %zu experts (leave-one-out):\n", k);
    std::printf("%-11s %9s %9s %9s %9s %9s %10s\n", "domain", "random", "global", "domain", "detected", "oracle", "detection");
    Row sum;
    for (const auto& d : domains) {
        const Row& r = rows[d];
        std::printf("%-11s %8.1f%% %8.1f%% %8.1f%% %8.1f%% %8.1f%% %6d/%d\n", d.c_str(), 100 * random_cov, 100 * r.global / r.n,
                    100 * r.domain / r.n, 100 * r.detected / r.n, 100 * r.oracle / r.n, r.correct, r.n);
        sum.global += r.global; sum.domain += r.domain; sum.detected += r.detected; sum.oracle += r.oracle;
        sum.correct += r.correct; sum.n += r.n;
    }
    std::printf("%-11s %8.1f%% %8.1f%% %8.1f%% %8.1f%% %8.1f%% %6d/%d\n", "ALL", 100 * random_cov, 100 * sum.global / sum.n,
                100 * sum.domain / sum.n, 100 * sum.detected / sum.n, 100 * sum.oracle / sum.n, sum.correct, sum.n);

    if (ws_ram_mib > 0) {
        const auto& st = source.store.stats();
        std::fprintf(stderr, "\nWeightStream: %llu requests, RAM hit %.1f%%, %.1f GiB read in %.1f s\n",
                     static_cast<unsigned long long>(st.requests), st.requests ? 100.0 * st.ram_hits / st.requests : 0.0,
                     st.disk_bytes / (1024.0 * 1024.0 * 1024.0), st.disk_seconds);
    }
    llama_sampler_free(smpl);
    llama_free(ctx);
    llama_model_free(model);
    llama_moe_set_expert_source(nullptr, nullptr);
    return 0;
}
