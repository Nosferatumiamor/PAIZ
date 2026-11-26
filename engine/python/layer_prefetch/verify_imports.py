import torch
from layer_streamer import LayerStreamer

print("OK CUDA:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("GPU:", torch.cuda.get_device_name(0))
