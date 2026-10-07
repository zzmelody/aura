import assert from "node:assert/strict";
import test from "node:test";
import { windowsListeningPids } from "../src/site-network.ts";

const header =
  "\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n";

// Slow Windows TCP CIM enumeration exceeded the ownership query's existing
// deadline. These fixtures test the replacement table parser independently of
// a machine's ports; the SiteRunner tests retain real process-ownership gates.
test("Windows numeric listener table filters exact port, IPv4/IPv6 and duplicate owners", () => {
  const table =
    header +
    [
      "TCP 0.0.0.0:4312 0.0.0.0:0 LISTENING 120",
      "TCP [::]:4312 [::]:0 LISTENING 120",
      "TCP [fe80::a%4]:4312 [::]:0 LISTENING 121",
      "TCP 127.0.0.1:43121 0.0.0.0:0 LISTENING 999",
      "TCP 127.0.0.1:4312 127.0.0.1:52000 ESTABLISHED 998",
      "TCP 127.0.0.1:52000 127.0.0.1:4312 TIME_WAIT 0",
    ].join("\r\n");
  assert.deepEqual(windowsListeningPids(table, 4312), [120, 121]);
  assert.deepEqual(windowsListeningPids(table, 4311), []);
  assert.deepEqual(windowsListeningPids(header, 4312), []);
  assert.deepEqual(
    windowsListeningPids(
      "活动连接\r\n 协议 本地地址 外部地址 状态 PID\r\n TCP 127.0.0.1:4312 0.0.0.0:0 LISTENING 120",
      4312,
    ),
    [120],
  );
});

test("Windows listener parser fails closed on unknown, incomplete or malformed output", () => {
  for (const output of [
    "",
    "Access is denied.",
    "TCP 127.0.0.1:4312 0.0.0.0:0 LISTENING 120",
    ...[
      "TCP 127.0.0.1:4312 0.0.0.0:0 LISTENING",
      "TCP 127.0.0.1:4312 0.0.0.0:0 LISTENING 120 ignored",
      "TCP 127.0.0.1:4312 0.0.0.0:0 LISTENING 1;evil",
      "TCP 127.0.0.1:4312 0.0.0.0:0 LISTENING 9007199254740993",
      "TCP 127.0.0.1:4312 0.0.0.0:0 LISTENING 0",
      "TCP 999.0.0.1:4312 0.0.0.0:0 LISTENING 120",
      "TCP localhost:4312 0.0.0.0:0 LISTENING 120",
      "TCP [fe80::a%evil]:4312 [::]:0 LISTENING 120",
      "TCP [::]:99999 [::]:0 LISTENING 120",
      "TCP 127.0.0.1:4312 garbage LISTENING 120",
      "TCP 127.0.0.1:4312 0.0.0.0:0 UNKNOWN 120",
      "UDP 127.0.0.1:4312 *:* LISTENING 120",
      "error while enumerating connections",
    ].map((row) => header + row),
  ])
    assert.equal(windowsListeningPids(output, 4312), null, output);
  for (const port of [0, 65536, 1.5, NaN])
    assert.equal(windowsListeningPids(header, port), null);
});
