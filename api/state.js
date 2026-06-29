// Vercel serverless function — stores Mum's favourites + hidden listings.
//
// Backed by Postgres (Neon). When you connect a Neon database in the Vercel
// dashboard (Storage → Postgres), Vercel injects DATABASE_URL / POSTGRES_URL
// automatically — no code change needed.
//
// Until a database URL is present, every response is { configured: false } and
// the website silently falls back to saving on the device (localStorage). So the
// site works the moment it deploys, and upgrades to synced once the DB is wired.
//
// Contract (so the front-end doesn't care which backend is used):
//   GET  /api/state                              -> { configured, favourites:[], hidden:[], snapshots:{id:{…}} }
//   POST /api/state  { action, id, snapshot? }   -> { configured, favourites:[], hidden:[], snapshots:{…} }
//     action ∈ favourite | unfavourite | hide | unhide
//
// A `snapshot` is a small copy of the favourited listing (address, link, photo,
// price, …) saved so a favourite still renders — and its link still works — even
// after the listing is delisted and drops out of the next data pull.

const { neon } = require("@neondatabase/serverless");

function dbUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.POSTGRES_URL_NON_POOLING ||
    null
  );
}

let _ready = null; // memoised "table exists" promise per warm instance

async function ensureReady(sql) {
  if (!_ready) {
    _ready = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS picks (
          listing_id TEXT NOT NULL,
          status     TEXT NOT NULL CHECK (status IN ('favourite','hidden')),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (listing_id, status)
        )
      `;
      // snapshot of the favourited listing, so it survives delisting
      await sql`ALTER TABLE picks ADD COLUMN IF NOT EXISTS data JSONB`;
    })();
  }
  await _ready;
}

async function getState(sql) {
  await ensureReady(sql);
  const rows = await sql`SELECT listing_id, status, data FROM picks`;
  const favourites = [];
  const hidden = [];
  const snapshots = {};
  for (const r of rows) {
    if (r.status === "favourite") {
      favourites.push(r.listing_id);
      if (r.data != null) {
        snapshots[r.listing_id] = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
      }
    } else {
      hidden.push(r.listing_id);
    }
  }
  return { favourites, hidden, snapshots };
}

async function apply(sql, action, id, snapshot) {
  switch (action) {
    case "favourite": {
      const snap = snapshot == null ? null : JSON.stringify(snapshot);
      // keep any existing snapshot if this call didn't supply one
      await sql`INSERT INTO picks (listing_id, status, data) VALUES (${id}, 'favourite', ${snap}::jsonb)
                ON CONFLICT (listing_id, status)
                DO UPDATE SET data = COALESCE(EXCLUDED.data, picks.data), updated_at = now()`;
      break;
    }
    case "unfavourite":
      await sql`DELETE FROM picks WHERE listing_id = ${id} AND status = 'favourite'`;
      break;
    case "hide":
      await sql`INSERT INTO picks (listing_id, status) VALUES (${id}, 'hidden')
                ON CONFLICT (listing_id, status) DO NOTHING`;
      break;
    case "unhide":
      await sql`DELETE FROM picks WHERE listing_id = ${id} AND status = 'hidden'`;
      break;
    default:
      return false;
  }
  return true;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const url = dbUrl();
  if (!url) {
    // No database connected yet — tell the client to use its local fallback.
    res.status(200).json({ configured: false, favourites: [], hidden: [] });
    return;
  }

  try {
    const sql = neon(url);

    if (req.method === "GET") {
      const state = await getState(sql);
      res.status(200).json({ configured: true, ...state });
      return;
    }

    if (req.method === "POST") {
      const body =
        typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const { action, id, snapshot } = body;
      if (!action || !id) {
        res.status(400).json({ error: "missing action or id" });
        return;
      }
      const ok = await apply(sql, action, String(id), snapshot);
      if (!ok) {
        res.status(400).json({ error: "unknown action: " + action });
        return;
      }
      const state = await getState(sql);
      res.status(200).json({ configured: true, ...state });
      return;
    }

    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
};
