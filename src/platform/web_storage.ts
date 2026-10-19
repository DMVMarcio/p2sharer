let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('p2sharer-web', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}

/** Resolve writes on transaction commit so quota failures never look like a saved document. */
export async function browserRecord<T>(key: string, mutation?: (previous: T | undefined) => T | undefined): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('records', mutation ? 'readwrite' : 'readonly');
    const store = transaction.objectStore('records');
    const request = store.get(key);
    let result: T | undefined;
    let failure: unknown;
    request.onsuccess = () => {
      try {
        result = mutation ? mutation(request.result) : request.result;
        if (mutation) { if (result === undefined) store.delete(key); else store.put(result, key); }
      } catch (error) { failure = error; transaction.abort(); }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = transaction.onerror = () => reject(failure ?? transaction.error ?? new Error('Browser storage failed'));
  });
}
