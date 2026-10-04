// Local storage on the phone (IndexedDB). Recipes and photos are kept in
// separate stores so the home screen stays fast even with lots of photos.

const DB_NAME = 'recipe-box';
const VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recipes')) db.createObjectStore('recipes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('photos')) {
        const s = db.createObjectStore('photos', { keyPath: 'id' });
        s.createIndex('recipeId', 'recipeId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function allRecipes() {
  return tx('recipes', 'readonly', (t) => reqP(t.objectStore('recipes').getAll()));
}
export function getRecipe(id) {
  return tx('recipes', 'readonly', (t) => reqP(t.objectStore('recipes').get(id)));
}
export function putRecipe(r) {
  r.updated = Date.now();
  if (!r.created) r.created = r.updated;
  return tx('recipes', 'readwrite', (t) => { t.objectStore('recipes').put(r); }).then(() => r);
}
export function deleteRecipe(id) {
  return tx(['recipes', 'photos'], 'readwrite', async (t) => {
    t.objectStore('recipes').delete(id);
    const ps = t.objectStore('photos');
    const keys = await reqP(ps.index('recipeId').getAllKeys(id));
    keys.forEach((k) => ps.delete(k));
  });
}

export function getPhotos(ids) {
  return tx('photos', 'readonly', (t) => Promise.all(ids.map((id) => reqP(t.objectStore('photos').get(id)))))
    .then((list) => list.filter(Boolean));
}
export function putPhoto(p) {
  return tx('photos', 'readwrite', (t) => { t.objectStore('photos').put(p); }).then(() => p);
}
export function deletePhoto(id) {
  return tx('photos', 'readwrite', (t) => { t.objectStore('photos').delete(id); });
}
export function allPhotos() {
  return tx('photos', 'readonly', (t) => reqP(t.objectStore('photos').getAll()));
}

export async function importAll(recipes, photos) {
  await tx(['recipes', 'photos'], 'readwrite', (t) => {
    const rs = t.objectStore('recipes'), ps = t.objectStore('photos');
    recipes.forEach((r) => rs.put(r));
    photos.forEach((p) => ps.put(p));
  });
}
