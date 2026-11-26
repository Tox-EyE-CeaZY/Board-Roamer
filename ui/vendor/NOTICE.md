# Third-party files bundled with Board Roamer

Used by the Feed's "Match art style" signal. Everything runs on the device; nothing here contacts a server.

## ort/ — ONNX Runtime Web 1.22.0

`ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm`, unchanged, from the `onnxruntime-web` package.
https://github.com/microsoft/onnxruntime — Copyright (c) Microsoft Corporation. MIT License.

## style/tinyclip-vision.onnx — TinyCLIP ViT-8M/16 (picture half)

TinyCLIP, https://github.com/microsoft/Cream/tree/main/TinyCLIP — Copyright (c) Microsoft Corporation. MIT License.
Taken from the ONNX export https://huggingface.co/onnx-community/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M-ONNX (`onnx/model_int8.onnx`)
and cut down with `tools/style-model.py` (text half removed, weight storage changed for the web runtime; same output).

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
