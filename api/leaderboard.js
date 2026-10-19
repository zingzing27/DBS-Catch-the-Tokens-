import { neon } from '@neondatabase/serverless';

let schemaReady;
let submitFunctionReady;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function getSql() {
  const connectionString = process.env.DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.POSTGRES_URL_NON_POOLING;

  if (!connectionString) {
    throw new Error('Database connection is not configured');
  }

  return neon(connectionString);
}

async function ensureTable(sql) {
  if (!schemaReady) {
    schemaReady = sql`
      CREATE TABLE IF NOT EXISTS game_scores (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        initials VARCHAR(5) NOT NULL CHECK (initials ~ '^[A-Z]{1,5}$'),
        score INTEGER NOT NULL CHECK (score >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  await schemaReady;
}

async function ensureSubmitFunction(sql) {
  if (!submitFunctionReady) {
    submitFunctionReady = sql`
    CREATE OR REPLACE FUNCTION submit_game_score(p_initials TEXT, p_score INTEGER)
    RETURNS TABLE (
      id BIGINT,
      initials TEXT,
      score INTEGER,
      created_at TIMESTAMPTZ,
      is_top BOOLEAN
    )
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      submitted_id BIGINT;
    BEGIN
      PERFORM pg_advisory_xact_lock(84651207);
      INSERT INTO game_scores (initials, score)
      VALUES (p_initials, p_score)
      RETURNING game_scores.id INTO submitted_id;

      DELETE FROM game_scores AS candidate_to_remove
      WHERE candidate_to_remove.id NOT IN (
        SELECT ranked.id FROM game_scores AS ranked
        ORDER BY ranked.score DESC, ranked.created_at ASC, ranked.id ASC
        LIMIT 5
      );

      RETURN QUERY
      SELECT game_scores.id, game_scores.initials::TEXT, game_scores.score,
             game_scores.created_at, (game_scores.id = submitted_id)
      FROM game_scores
      ORDER BY game_scores.score DESC, game_scores.created_at ASC, game_scores.id ASC
      LIMIT 5;
    END;
    $function$
  `.catch((error) => {
    submitFunctionReady = undefined;
    throw error;
  });
  }
  await submitFunctionReady;
}

function serialize(rows) {
  return rows.map((row) => ({
    name: row.initials,
    score: Number(row.score),
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.is_top === undefined ? {} : { isTop: Boolean(row.is_top) }),
  }));
}

export default {
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    try {
      const sql = getSql();
      await ensureTable(sql);

      if (request.method === 'GET') {
        const rows = await sql`
          SELECT initials, score, created_at
          FROM game_scores
          ORDER BY score DESC, created_at ASC, id ASC
          LIMIT 5
        `;
        return json({ scores: serialize(rows) });
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Please send a valid score.' }, 400);
      }

      const name = typeof body?.name === 'string'
        ? body.name.trim().toUpperCase()
        : '';
      const score = Number(body?.score);

      if (!/^[A-Z]{1,5}$/.test(name)) {
        return json({ error: 'Name must contain 1 to 5 letters.' }, 400);
      }
      if (!Number.isSafeInteger(score) || score < 0 || score > 100000) {
        return json({ error: 'Score is invalid.' }, 400);
      }

      await ensureSubmitFunction(sql);
      const rows = await sql`
        SELECT * FROM submit_game_score(${name}, ${score})
      `;
      const scores = serialize(rows);
      return json({ scores, saved: scores.some((entry) => entry.isTop) });
    } catch (error) {
      console.error('Leaderboard request failed:', error);
      const notConfigured = error instanceof Error
        && error.message === 'Database connection is not configured';
      return json({
        error: notConfigured
          ? 'Connect your Neon database to Vercel to enable the global leaderboard.'
          : 'The leaderboard could not be reached. Please try again shortly.',
      }, notConfigured ? 503 : 500);
    }
  },
};
