export async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(
      `promise rejected with a non-error value: ${String(error)}`,
    );
  }
  throw new Error('expected the promise to reject, but it resolved');
}
