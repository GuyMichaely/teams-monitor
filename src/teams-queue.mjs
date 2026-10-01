// The GUI owns CDP operations; callers in other processes use teams-client.
export function operationQueue() {
  let tail = Promise.resolve();
  return { run(operation) {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  } };
}
export const teamsQueue = operationQueue();
