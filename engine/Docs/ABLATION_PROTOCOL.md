# Ablation Protocol Draft

Goal: measure whether a logical transformer layer can be bypassed, approximated, or
left unchanged for a given prompt class without dropping below an acceptable quality
threshold.

This is a draft protocol. It is intentionally model-agnostic and layer-agnostic.

## What we test

- One logical layer at a time
- Small groups of adjacent layers
- Shared tensors separately from transformer blocks

## What we do not test

- Arbitrary storage pages
- Random tensor slices
- "Layer competence" in isolation as if a block could answer a prompt alone

## Prompt classes

- Greeting / trivial chat
- Short factual question
- Short translation
- Code completion
- Multi-step reasoning
- Creative writing

## Measurements

- Latency
- Tokens per second
- Final answer quality
- Deviation from baseline output
- Confidence or stability across multiple runs

## Layer actions

- Baseline: no bypass
- Identity bypass: x_out = x_in
- Approximate bypass: reduced-cost substitute
- Full execution

## Decision rule

A layer is a bypass candidate only if:

- the quality drop stays below a threshold for the target prompt class, and
- the speed or cost gain is large enough to justify the loss.

## Notes

The first usable artifact is the JSON manifest produced by `ws_inspect_gguf --json`.
It should be easy to feed into an external test runner later.
