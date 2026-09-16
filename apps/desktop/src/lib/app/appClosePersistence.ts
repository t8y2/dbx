interface FinishAppCloseWithRequiredPersistOptions {
  persist: () => Promise<void>;
  beforeClose?: () => Promise<void>;
  close: () => Promise<void>;
  onPersistError: (error: unknown) => void;
}

export async function finishAppCloseWithRequiredPersist(options: FinishAppCloseWithRequiredPersistOptions): Promise<boolean> {
  try {
    await options.persist();
  } catch (error) {
    options.onPersistError(error);
    return false;
  }

  await options.beforeClose?.();
  await options.close();
  return true;
}
