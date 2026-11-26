import subprocess,re,os,sys,json
S=os.path.dirname(os.path.abspath(__file__))
TOK=r"D:\005-GIT\PAIZ\engine\build-llama\bin\ws_tok_tmp.exe"
M=r"C:\llm-models\Qwen3-Coder-Next\Qwen3-Coder-Next-Q4_K_M.gguf"
def tok(text,name):
    p=os.path.join(S,name); open(p,'w',encoding='utf-8',newline='').write(text)
    r=subprocess.run([TOK,M,p],capture_output=True,text=True)
    return [int(x) for x in r.stdout.split()]
def hunks(diff):
    out=[];f=None;cur=None
    for l in diff.split('\n'):
        if l.startswith('diff --git'): f=l.split(' b/')[-1]
        elif l.startswith('@@'): cur=[f,[]]; out.append(cur)
        elif cur and not l.startswith(('---','+++','\\')) and l!='' : cur[1].append(l)
    return out
def outputs(diff):
    A=[];B=[]
    for f,ls in hunks(diff):
        added=[l[1:] for l in ls if l[0]=='+']
        A.append('\n'.join(added)+'\n')
        old=[l[1:] for l in ls if l[0] in ' -']; new=[l[1:] for l in ls if l[0] in ' +']
        B.append('{"name":"edit","arguments":{"file_path":"%s","old_string":%s,"new_string":%s}}\n'%(f,json.dumps('\n'.join(old)),json.dumps('\n'.join(new))))
    return ''.join(A),''.join(B)
def sim(ctx,out,n,k,pick):
    BS=[]; seq=list(ctx); i=0; steps=0; acc=0; drafted_steps=0; N=len(out)
    # index of ngram -> positions
    idx={}
    def add(p):  # ngram ending at p (inclusive)
        if p+1>=n: idx.setdefault(tuple(seq[p+1-n:p+1]),[]).append(p+1)  # store start of continuation
    for p in range(len(seq)): add(p)
    while i<N:
        steps+=1
        d=[]
        if len(seq)>=n:
            c=idx.get(tuple(seq[-n:]),[])
            c=[x for x in c if x<len(seq)]
            if c:
                s=c[-1] if pick=='recent' else c[0]
                d=seq[s:s+k]
        a=0
        while a<len(d) and i+a<N and d[a]==out[i+a]: a+=1
        if d: drafted_steps+=1
        BS.append(1+len(d))
        take=min(a+1,N-i); acc+=a
        for t in out[i:i+take]: seq.append(t); add(len(seq)-1)
        i+=take
    return dict(N=N,steps=steps,tps=N/steps,acc=acc,drafted=drafted_steps,bs=BS)
res={}
for tag,base,diff in (("s1","fc7ba93","d1.diff"),("s2","aa7f7db","d2.diff")):
    d=open(os.path.join(S,diff),encoding='utf-8').read()
    ctxt=''
    for f in ("index.html","style.css","game.js","README.md"):
        ctxt+="=== %s ===\n"%f+open(os.path.join(S,"ctx_"+base,f),encoding='utf-8').read()+"\n"
    A,B=outputs(d)
    ctx=tok(ctxt,"ctx_%s.txt"%tag); oa=tok(A,"outA_%s.txt"%tag); ob=tok(B,"outB_%s.txt"%tag)
    print(tag,"ctx tokens",len(ctx),"outA",len(oa),"outB",len(ob))
    res[tag]=(ctx,oa,ob)
def run(label,items):
    for k in (4,8):
        for n in (2,3,4):
            for pick in ('recent',):
                tot=dict(N=0,steps=0,acc=0,drafted=0); allbs=[]
                for ctx,out in items:
                    r=sim(ctx,out,n,k,pick)
                    for x in tot: tot[x]+=r[x]
                    allbs+=r['bs']
                print(f"{label} k={k} n={n}: tok={tot['N']} steps={tot['steps']} tok/step={tot['N']/tot['steps']:.2f} accepted={tot['acc']} ({tot['acc']/tot['N']*100:.0f}% of tokens) drafted_steps={tot['drafted']} mean_batch={sum(allbs)/len(allbs):.2f} sum_batch={sum(allbs)}")
run("A(added lines only)",[(res['s1'][0],res['s1'][1]),(res['s2'][0],res['s2'][1])])
run("B(edit tool call)   ",[(res['s1'][0],res['s1'][2]),(res['s2'][0],res['s2'][2])])
