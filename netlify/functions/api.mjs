import { getStore } from "@netlify/blobs";
import seed from "./seed.json" with { type: "json" };

// Дані: одна квартира = один blob "apt/<id>". Фото = blob "photo/<id>".
const STATUSES = ["noted", "contacted", "called", "responded", "viewing", "declined", "success"];
const FIELDS = ["address", "link", "price", "notes", "status"];
const MAX_PHOTOS = 20;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

const store = () => getStore({ name: "apartments", consistency: "strong" });

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

function clean(input) {
  const out = {};
  for (const k of FIELDS) {
    if (typeof input?.[k] === "string") out[k] = input[k].slice(0, 5000);
  }
  if (out.status && !STATUSES.includes(out.status)) delete out.status;
  // Кілька фото: масив шляхів. Старе поле photoUrl теж приймаємо.
  let photos = Array.isArray(input?.photos) ? input.photos : typeof input?.photoUrl === "string" ? [input.photoUrl] : null;
  if (photos) out.photos = photos.filter(isPhotoPath).slice(0, MAX_PHOTOS);
  return out;
}

const isPhotoPath = (p) => typeof p === "string" && /^\/(api\/photos|photos)\/[\w.-]+$/.test(p);

// Старі записи мають photoUrl — перетворюємо на масив photos.
function normalize(apt) {
  if (!apt) return apt;
  const { photoUrl, ...rest } = apt;
  return { ...rest, photos: Array.isArray(apt.photos) ? apt.photos : photoUrl ? [photoUrl] : [] };
}

const blobKey = (p) => (p.startsWith("/api/photos/") ? `photo/${p.split("/").pop()}` : null);

async function deletePhotos(s, paths) {
  await Promise.all(paths.map(blobKey).filter(Boolean).map((k) => s.delete(k)));
}

// Редагування захищене паролем, якщо в Netlify задано змінну APP_PASSWORD.
const getPassword = () =>
  (globalThis.Netlify?.env?.get("APP_PASSWORD") ?? process.env.APP_PASSWORD ?? "").trim();

function canWrite(req) {
  const pw = getPassword();
  if (!pw) return true;
  return req.headers.get("x-password") === pw;
}

async function ensureSeeded(s) {
  const marker = await s.get("meta/seeded");
  if (marker) return;
  await Promise.all(seed.map((a) => s.setJSON(`apt/${a.id}`, a)));
  await s.set("meta/seeded", new Date().toISOString());
}

async function listApartments(s) {
  await ensureSeeded(s);
  const { blobs } = await s.list({ prefix: "apt/" });
  const items = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return items.filter(Boolean).map(normalize).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const [resource, id] = parts;
  const method = req.method;
  const s = store();

  try {
    if (resource === "auth" && method === "GET") {
      return json({ required: !!getPassword(), ok: canWrite(req) });
    }

    if (resource === "apartments") {
      if (method === "GET" && !id) return json(await listApartments(s));

      if (!canWrite(req)) return json({ error: "Неверный пароль" }, 401);

      if (method === "POST" && !id) {
        const body = clean(await req.json());
        if (!body.address && !body.link) return json({ error: "Нужен адрес или ссылка" }, 400);
        const now = Date.now();
        const apt = { address: "", link: "", price: "", notes: "", photos: [], status: "noted", ...body, id: newId(), createdAt: now, updatedAt: now };
        await s.setJSON(`apt/${apt.id}`, apt);
        return json(apt, 201);
      }

      if (method === "PATCH" && id) {
        const current = normalize(await s.get(`apt/${id}`, { type: "json" }));
        if (!current) return json({ error: "Не найдено" }, 404);
        const updated = { ...current, ...clean(await req.json()), id, updatedAt: Date.now() };
        await s.setJSON(`apt/${id}`, updated);
        // Прибираємо з Blobs фото, які прибрали з квартири.
        await deletePhotos(s, current.photos.filter((p) => !updated.photos.includes(p)));
        return json(updated);
      }

      if (method === "DELETE" && id) {
        const current = normalize(await s.get(`apt/${id}`, { type: "json" }));
        await s.delete(`apt/${id}`);
        if (current) await deletePhotos(s, current.photos);
        return json({ ok: true });
      }
    }

    if (resource === "photos") {
      if (method === "GET" && id) {
        const res = await s.getWithMetadata(`photo/${id}`, { type: "arrayBuffer" });
        if (!res) return new Response("Not found", { status: 404 });
        return new Response(res.data, {
          headers: {
            "content-type": res.metadata?.contentType || "image/jpeg",
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      }
      if (method === "POST" && !id) {
        if (!canWrite(req)) return json({ error: "Неверный пароль" }, 401);
        const contentType = req.headers.get("content-type") || "";
        if (!contentType.startsWith("image/")) return json({ error: "Это не изображение" }, 400);
        const buf = await req.arrayBuffer();
        if (buf.byteLength > MAX_PHOTO_BYTES) return json({ error: "Фото слишком большое" }, 413);
        const key = newId();
        await s.set(`photo/${key}`, buf, { metadata: { contentType } });
        return json({ url: `/api/photos/${key}` }, 201);
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: e.message || "Server error" }, 500);
  }
};

export const config = { path: "/api/*" };
