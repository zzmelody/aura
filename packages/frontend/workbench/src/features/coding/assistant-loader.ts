/** Shares the assistant lookup for one backend during the lifetime of a window. */
export function createAssistantLoader(
  request: (create: boolean, signal: AbortSignal) => Promise<boolean>,
) {
  let opening:
    | {
        create: boolean;
        abort: AbortController;
        result: Promise<boolean>;
      }
    | undefined;

  function load(create = false): Promise<boolean> {
    if (opening) {
      const current = opening;
      if (!create || current.create) return current.result;
      return current.result.then(
        (found) => found || (!current.abort.signal.aborted && load(true)),
      );
    }

    const abort = new AbortController();
    const result = request(create, abort.signal).then((found) => {
      if (!found && opening?.abort === abort) opening = undefined;
      return found && !abort.signal.aborted;
    });
    opening = { create, abort, result };
    return result;
  }

  return {
    load,
    cancel() {
      opening?.abort.abort();
      opening = undefined;
    },
  };
}
