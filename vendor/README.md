# HashWX

`../src/hashwx.wasm` is copied unchanged from Cap revision
`15f8ef61edb3cd999521967caca9c0725d490782` (`core/vendor/hashwx.wasm`).
Its source revision is `74b567a31276a4c5d7cb232a5b7639467f49f961`
from <https://github.com/tevador/hashwx>.

The complete source for that revision is included as `hashwx-source.tar.gz`,
with the original CMake build files, headers, source, license, and README.
To rebuild with Emscripten and CMake:

```sh
mkdir hashwx-source
cd hashwx-source
tar xzf ../hashwx-source.tar.gz
emcmake cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
# Replace kaputt/src/hashwx.wasm with build/hashwx.wasm.
```

This is an interface-compatible rebuild; byte-for-byte reproducibility of Cap's
binary depends on its original compiler/toolchain. The JavaScript wrappers are
provided in source form, so the library can be modified and relinked/replaced.
The binary SHA-256 is pinned in `test/core.test.js`; update that pin when replacing
it and run both the unit and browser checks.

HashWX is LGPL-3.0. Both the LGPL supplement (`COPYING.LESSER`) and GPL-3.0
(`COPYING`) are included. These terms apply to HashWX; kaputt's JavaScript and
widget CSS use Apache-2.0. See the root `NOTICE` for attribution.
