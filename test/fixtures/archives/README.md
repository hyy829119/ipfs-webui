# Archive fixtures

`sample.zip` and `sample.tar.gz` contain IFShare test text, an empty file, a nested JavaScript file and a Chinese filename. They were generated for these tests with Python's standard `zipfile` and `tarfile` modules.

`ifshare-multiple.tar` was generated in an isolated offline repository using the local IFShare binary (`ifshare add -r -Q`, then `ifshare get --archive`). It uses the same Boxo `files.NewTarWriter` as the gateway's `format=tar` multi-file download. It contains four test files under a CID root: `hello.txt`, `empty.txt`, `中文/说明.txt` and a long JavaScript filename. This covers the gateway writer's USTAR/PAX headers and the filename handling needed for those downloads.

RAR fixtures are from the MIT-licensed [libarchive.js test suite](https://github.com/nika-begiashvili/libarchivejs/tree/master/test/files/archives/rar):

- `rar-v4.rar`: Git blob `a7ee422748088aaea714ef3e766265c2a0dfd405`.
- `rar-v5.rar`: Git blob `eba1f7365c9a44c2f6e0961267a69ea2da804180`.

The RAR files are used only as test data; no archived code is executed.
