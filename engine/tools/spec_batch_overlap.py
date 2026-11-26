import struct, sys, collections
def load(f):
    d = open(f, 'rb').read(); p = 0; recs = []
    while p + 12 <= len(d):
        il, nt, nu = struct.unpack_from('<3i', d, p); p += 12
        ids = struct.unpack_from('<%di' % nu, d, p); p += 4 * nu
        recs.append((il, nt, ids))
    return recs
for K in (1, 4, 8):
    try:
        r = load('t%d.bin' % K)
    except Exception as e:
        print(K, 'no trace', e); continue
    r = [x for x in r if x[0] != 47 or True]
    by_nt = collections.Counter(x[1] for x in r)
    sel = [x for x in r if x[1] == K]
    if not sel: print(K, 'no plans with n_tokens==K', by_nt.most_common(5)); continue
    mean_u = sum(len(x[2]) for x in sel) / len(sel)
    print(f"K={K}: plans={len(sel)} (steps={len(sel)//48 if len(sel)>=48 else '?'}) mean distinct experts per layer per step = {mean_u:.2f} ; independent bound = {10*K}; per token = {mean_u/K:.2f}")
# offline: union of K consecutive tokens from the K=1 trace
r1 = [x for x in load('t1.bin') if x[1] == 1]
L = 48
per = collections.defaultdict(list)
for il, nt, ids in r1: per[il].append(set(ids))
for K in (2, 4, 8):
    tot = 0; n = 0
    for il, lst in per.items():
        for s in range(0, len(lst) - K + 1, K):
            u = set().union(*lst[s:s + K]); tot += len(u); n += 1
    print(f"offline union of {K} consecutive tokens (K=1 trace): mean distinct experts/layer = {tot/n:.2f} of {10*K} ({tot/n/(10*K)*100:.0f}%)")
