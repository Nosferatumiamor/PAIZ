// Runs a command with a HARD working-set cap (pages beyond the cap are evicted, file-mapped pages included),
// to emulate a machine where the process really has only N MiB. Usage: ws_run_capped --max-mib N -- cmd args...
#include <windows.h>

#include <cstdio>
#include <cstdlib>
#include <string>

int main(int argc, char** argv) {
    double max_mib = 0;
    int i = 1;
    for (; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--max-mib" && i + 1 < argc) {
            max_mib = std::atof(argv[++i]);
        } else if (a == "--") {
            ++i;
            break;
        }
    }
    if (max_mib <= 0 || i >= argc) {
        std::fprintf(stderr, "Usage: ws_run_capped --max-mib N -- command [args...]\n");
        return 2;
    }
    std::string cmd;
    for (; i < argc; ++i) {
        const std::string a = argv[i];
        cmd += (cmd.empty() ? "" : " ") + (a.find(' ') != std::string::npos ? "\"" + a + "\"" : a);
    }
    STARTUPINFOA si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessA(nullptr, cmd.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED, nullptr, nullptr, &si, &pi)) {
        std::fprintf(stderr, "CreateProcess failed (%lu)\n", GetLastError());
        return 3;
    }
    const SIZE_T bytes = static_cast<SIZE_T>(max_mib * 1024.0 * 1024.0);
    if (!SetProcessWorkingSetSizeEx(pi.hProcess, 16u << 20, bytes, QUOTA_LIMITS_HARDWS_MIN_DISABLE | QUOTA_LIMITS_HARDWS_MAX_ENABLE)) {
        std::fprintf(stderr, "SetProcessWorkingSetSizeEx failed (%lu), running uncapped\n", GetLastError());
    }
    ResumeThread(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    return static_cast<int>(code);
}
