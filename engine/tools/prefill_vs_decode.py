import struct,sys,random
from collections import defaultdict,OrderedDict,Counter
import numpy as np
def rd(p,withids):
    d=open(p,'rb').read();i=0;out=[]
    while i+12<=len(d):
        il,nt,k=struct.unpack_from('<iii',d,i);i+=12
        a=np.frombuffer(d,dtype='<i4',count=k,offset=i);i+=4*k;out.append((il,nt,a))
    return out
ids=rd('ids.bin',1); tr=rd('t.bin',0)
L=max(r[0] for r in tr)+1; E=512
print('layers',L,'prefill records',len(ids),'ntok',set(r[1] for r in ids))
# prefill: [layer] -> list of (token_index, experts) ; token-major, topk per token
topk=None; pre={}
for il,nt,a in ids:
    il=-1-il
    topk=len(a)//nt; pre.setdefault(il,[]).append(a.reshape(nt,topk))
pre={il:np.concatenate(v) for il,v in pre.items()}
T=pre[0].shape[0]; print('prefill tokens',T,'topk',topk)
L=47
dec=[(il,a) for il,nt,a in tr if nt==1 and il<L]
print('decode records',len(dec),'tokens ~',len(dec)/L, 'per rec',Counter(len(a) for _,a in dec).most_common(2))
# decode counts
dcnt=np.zeros((L,E))
for il,a in dec: dcnt[il,a]+=1
def freq(variant):
    f=np.zeros((L,E))
    for il in range(L):
        m=pre[il]
        if variant=='all': sel=m; w=None
        elif variant=='last256': sel=m[-256:]
        elif variant=='ramp':
            w=np.linspace(0.05,1,len(m))
            for t in range(len(m)): f[il,m[t]]+=w[t]
            continue
        np.add.at(f[il],sel.ravel(),1)
    return f
fr={v:freq(v) for v in ['all','last256','ramp']}
tot=dcnt.sum()
print('\nCoverage of decode accesses by top-N prefill experts per layer (random = N/512)')
print('N%   n/layer  random  all   last256  ramp   oracle(decode-self)')
rng=np.random.default_rng(0)
for pct in [5,10,25,50]:
    n=int(E*pct/100); row=[]
    for v in ['all','last256','ramp']:
        c=0
        for il in range(L):
            top=np.argsort(-fr[v][il],kind='stable')[:n]; c+=dcnt[il,top].sum()
        row.append(c/tot)
    o=sum(np.sort(dcnt[il])[::-1][:n].sum() for il in range(L))/tot
    # random with tie noise: expected N/E
    print(f'{pct:>3}%  {n:>5}   {n/E*100:5.1f}% '+'  '.join(f'{x*100:5.1f}%' for x in row)+f'   {o*100:5.1f}%')
# unseen in prefill?
print('prefill experts never routed per layer (avg):',np.mean([(fr['all'][il]==0).sum() for il in range(L)]))
# step 4: simulation. budget in slots
expert_mib=float(sys.argv[1]) if len(sys.argv)>1 else 1.9
def seq_by_token():
    toks=[];cur=[]
    for il,a in dec:
        cur.append((il,a))
        if il==L-1: toks.append(cur);cur=[]
    return toks
toks=seq_by_token(); print('decode tokens',len(toks))
def run(cap_total,preload,var=None,policy='lru',pin=False):
    cap=max(1,cap_total//L)   # per layer
    caches=[OrderedDict() for _ in range(L)]
    pinned=[set() for _ in range(L)]
    if preload:
        for il in range(L):
            top=np.argsort(-fr[var][il],kind='stable')[:cap]
            for e in top[::-1]: caches[il][int(e)]=1
            if pin: pinned[il]=set(int(e) for e in top)
    hit=miss=0; cum=[]
    for tk in toks:
        h=m=0
        for il,a in tk:
            c=caches[il]
            for e in map(int,a):
                if e in c:
                    h+=1; c.move_to_end(e)
                else:
                    m+=1
                    if len(c)>=cap:
                        for old in c:
                            if old not in pinned[il]: del c[old]; break
                    c[e]=1
        hit+=h;miss+=m;cum.append((h,m))
    return hit,miss,cum
print('\nStep 4 (per-layer equal split of budget; LRU; expert=%.2f MiB)'%expert_mib)
print('budget  slots/layer  cold-LRU miss | preload(all)+LRU | preload(last256) | preload(ramp) | pinned-static(all) | MB/token saved (all)')
nt=len(toks)
for gb in [1,2,4,7.5]:
    cap_total=int(gb*1024/expert_mib)
    res={}
    res['cold']=run(cap_total,False)
    for v in ['all','last256','ramp']: res[v]=run(cap_total,True,v)
    res['pin']=run(cap_total,True,'all',pin=True)
    def mr(r): return r[1]/(r[0]+r[1])
    saved=(res['cold'][1]-res['all'][1])*expert_mib/nt
    print(f'{gb} GB  {cap_total//L:>4}  {mr(res["cold"])*100:6.2f}% | {mr(res["all"])*100:6.2f}% | {mr(res["last256"])*100:6.2f}% | {mr(res["ramp"])*100:6.2f}% | {mr(res["pin"])*100:6.2f}% | {saved:.2f}')
    # first 20 tokens
    def mrf(r,a,b):
        h=sum(x[0] for x in r[2][a:b]);m=sum(x[1] for x in r[2][a:b]);return m/(h+m)
    print('      first20 tok miss: cold %.1f%% preload %.1f%% ; rest: cold %.1f%% preload %.1f%%'%(mrf(res['cold'],0,20)*100,mrf(res['all'],0,20)*100,mrf(res['cold'],20,nt)*100,mrf(res['all'],20,nt)*100))
# LFU-like oracle: static top by decode itself (upper bound for any frequency pinning)
cap_total=int(2*1024/expert_mib);cap=cap_total//L
c=sum(np.sort(dcnt[il])[::-1][:cap].sum() for il in range(L))/tot
print('oracle static top-%d/layer by decode itself covers %.1f%% ; prefill-top %.1f%%'%(cap,c*100,sum(dcnt[il,np.argsort(-fr['all'][il],kind='stable')[:cap]].sum() for il in range(L))/tot*100))
