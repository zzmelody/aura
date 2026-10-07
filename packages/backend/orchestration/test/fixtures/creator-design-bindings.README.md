# Legacy creator binding capacity fixture

`creator-design-bindings.json` preserves the 26-record, 260,967-byte index that blocked the 0.15.5 acceptance submission. Its five `worldDesignRecovery` objects are the complete original public protocol values, in original field order. Only host-local `sessionPath` characters are replaced with `x`, preserving separators and encoded byte length. There are no tokens, endpoints, process logs or executable dependencies.

Fixture SHA256: `ef0ad12aa878ee3f7dfff0e672e6c8fb4b2337a1a13ede04f435b928748408ce`.

| Recovery request                     | Original compact recovery bytes | SHA256                                                           |
| ------------------------------------ | ------------------------------: | ---------------------------------------------------------------- |
| 113ad21e-1538-49e2-9c70-c00605097212 |                          34,989 | 986b875c9ebdba8c14b26def830555f9d39cce239f129d44aa4970da0145a747 |
| da63de96-b706-42e0-bd86-8abf6665d641 |                          34,988 | 39c7703665f56ece1ef14ace3a8d76ba47e083418ba0fe402b5fc55459b4e729 |
| 880760d5-8b63-4bbc-9735-16ab8394d7d7 |                          44,098 | cf8e984f6c06916ab8c7a7b107f4302c7af9e786538b9c0cc8467196c200b298 |
| d66e2615-383e-443c-9f3e-5790e9765d8f |                          40,477 | ff9c8a60577b7cc73eadc491dc42324fcd01344ad3f6a5843f1cfedc77c4cfe0 |
| b1e8e218-5cd6-4843-a597-b2cac5989c63 |                          49,572 | 6d2dc38985f5dd3ee9c54c1c447d58dc11eee4e4505ed1aef3083860228860dd |

Tests copy this file into owned temporary directories. They never load the real acceptance project's store or start Veya. Non-design references remain opaque fixture metadata; tests do not fabricate their production grants.

On non-Windows hosts, setup maps only each binding's host `sessionPath` to a deterministic absolute POSIX mock path. Equal source/owner paths stay equal, and the JSON-encoded path length stays unchanged. The adapted index is still 260,967 bytes; its SHA256 and backup filename use `13670256ebc19b9aca07ee5e89b95e1287b58cf917ded4142c09c86a9d633b1f`. The original fixture SHA above and all five recovery byte hashes are asserted separately and remain unchanged. This adaptation is tested on Windows too; it does not normalize production paths or constitute an actual macOS test run. Runtime route fixtures already construct their worker paths from the host temporary directory.
