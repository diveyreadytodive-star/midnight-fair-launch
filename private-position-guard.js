export function clearPrivatePositionList(listElement) {
  listElement.replaceChildren();
  listElement.hidden = true;
}

export function createPrivatePositionReadGuard(isActiveView) {
  let generation = 0;
  let requestSequence = 0;

  function invalidate() {
    generation += 1;
    requestSequence += 1;
  }

  async function run(load, onSuccess, onError) {
    if (!isActiveView()) return false;
    const requestGeneration = generation;
    const requestId = ++requestSequence;
    const isCurrent = () => isActiveView()
      && requestGeneration === generation
      && requestId === requestSequence;

    try {
      const result = await load();
      if (!isCurrent()) return false;
      onSuccess(result);
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      onError(error);
      return false;
    }
  }

  return { invalidate, run };
}
