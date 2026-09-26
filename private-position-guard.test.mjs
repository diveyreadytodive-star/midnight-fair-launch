import assert from "node:assert/strict";
import test from "node:test";
import { clearPrivatePositionList, createPrivatePositionReadGuard } from "./private-position-guard.js";

class PositionListElement {
  children = [];
  hidden = false;

  replaceChildren(...children) {
    this.children = children;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("observer switch clears the position DOM and drops a late private response", async () => {
  let view = "trader";
  let applied = false;
  const list = new PositionListElement();
  list.children = [{ textContent: "LONG · 1,000 tUSD · guard 40" }];
  const pendingRead = deferred();
  const guard = createPrivatePositionReadGuard(() => view === "trader");

  const read = guard.run(
    () => pendingRead.promise,
    (positions) => {
      applied = true;
      list.hidden = false;
      list.replaceChildren(...positions.map((position) => ({ textContent: `${position.side} · ${position.notional}` })));
    },
    () => assert.fail("The pending read should resolve successfully, then be discarded as stale."),
  );

  view = "observer";
  guard.invalidate();
  clearPrivatePositionList(list);
  assert.deepEqual(list.children, []);
  assert.equal(list.hidden, true);

  pendingRead.resolve([{ side: "short", notional: "5000" }]);
  assert.equal(await read, false);
  assert.equal(applied, false);
  assert.deepEqual(list.children, []);
  assert.equal(list.hidden, true);
});

test("a 401/session-expiry path can scrub previously rendered positions", async () => {
  let view = "trader";
  const list = new PositionListElement();
  list.children = [{ textContent: "SHORT · 5,000 tUSD · entry 62,000" }];
  const guard = createPrivatePositionReadGuard(() => view === "trader");

  await guard.run(
    async () => { throw Object.assign(new Error("expired"), { status: 401 }); },
    () => assert.fail("A 401 must not render positions."),
    (error) => {
      assert.equal(error.status, 401);
      clearPrivatePositionList(list);
    },
  );

  assert.deepEqual(list.children, []);
  assert.equal(list.hidden, true);
  view = "observer";
  guard.invalidate();
  assert.deepEqual(list.children, []);
});
