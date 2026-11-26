// tok <model.gguf> <file> : prints token ids (one line), special parse off
#include "llama.h"
#include <cstdio>
#include <string>
#include <vector>
#include <fstream>
#include <sstream>
int main(int argc,char**argv){
  if(argc<3) return 1;
  llama_backend_init();
  llama_model_params mp=llama_model_default_params(); mp.vocab_only=true;
  llama_model* m=llama_model_load_from_file(argv[1],mp);
  if(!m){fprintf(stderr,"load fail\n");return 2;}
  const llama_vocab* v=llama_model_get_vocab(m);
  std::ifstream f(argv[2],std::ios::binary); std::stringstream ss; ss<<f.rdbuf(); std::string t=ss.str();
  int n=-llama_tokenize(v,t.c_str(),(int)t.size(),nullptr,0,false,false);
  std::vector<llama_token> tk(n);
  llama_tokenize(v,t.c_str(),(int)t.size(),tk.data(),n,false,false);
  for(int i=0;i<n;i++) printf("%d%c",tk[i],i+1<n?' ':'\n');
}
