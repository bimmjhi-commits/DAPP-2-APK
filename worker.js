
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://dapp-2-apk.vercel.app",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function toBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function decodeDataUrl(value) {
  if (!value || typeof value !== "string") return null;
  const match = value.match(/^data:image\/(?:png|jpeg|jpg);base64,([A-Za-z0-9+/=]+)$/);
  return match ? match[1] : null;
}

async function verifyTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET_KEY || !token) return false;

  const formData = new FormData();
  formData.append("secret", env.TURNSTILE_SECRET_KEY);
  formData.append("response", token);

  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) formData.append("remoteip", ip);

  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      body: formData
    }
  );

  const data = await res.json();

  return data.success === true &&
    data.hostname === "dapp-2-apk.vercel.app";
}

async function github(env, path, options = {}) {
  const response = await fetch("https://api.github.com" + path, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": "Bearer " + env.GITHUB_TOKEN,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "DAPP-BUILDER",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error("GitHub API " + response.status + ": " + message.slice(0, 500));
  }

  if (response.status === 204) return {};
  return response.json();
}

async function saveFile(env, path, content) {
  return github(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "DAPP Builder: save build request",
        content: toBase64(content),
        branch: env.GITHUB_BRANCH || "main"
      })
    }
  );
}

async function startBuild(request, env) {
  const body = await request.json();

  if (!env.TURNSTILE_SECRET_KEY) {
    return json({
      ok: false,
      error: "Konfigurasi Turnstile belum tersedia."
    }, 500);
  }

  const token = body.turnstileToken;

  if (!token || !(await verifyTurnstile(token, request, env))) {
    return json({
      ok: false,
      error: "Verifikasi Cloudflare gagal. Silakan coba lagi."
    }, 403);
  }

  const config = body.config || body;

  const appName = String(config.appName || "").trim();
  const packageName = String(config.packageName || "").trim();
  const sourceType = config.sourceType || "url";

  if (!appName || !packageName) {
    return json({ ok: false, error: "Nama aplikasi dan package name wajib diisi." }, 400);
  }

  if (!["url", "html"].includes(sourceType)) {
    return json({ ok: false, error: "Jenis sumber tidak valid." }, 400);
  }

  if (sourceType === "url" && !/^https?:\/\//i.test(config.url || "")) {
    return json({ ok: false, error: "URL website tidak valid." }, 400);
  }

  if (sourceType === "html" && !String(body.html || "").trim()) {
    return json({ ok: false, error: "HTML tidak boleh kosong." }, 400);
  }

  const buildId = crypto.randomUUID();
  const folder = `build-requests/${buildId}`;

  const savedConfig = {
    appName,
    packageName,
    version: config.version || "1.0",
    sourceType,
    url: sourceType === "url" ? config.url : "",
    orientation: config.orientation || "sensor",
    fullscreen: !!config.fullscreen,
    keepScreenOn: !!config.keepScreenOn,
    permissions: config.permissions || {}
  };

  await saveFile(env, `${folder}/config.json`, JSON.stringify(savedConfig, null, 2));

  if (sourceType === "html") {
    await saveFile(env, `${folder}/index.html`, body.html);
  }

  const icon = decodeDataUrl(body.logoDataUrl);
  if (icon) {
    const bytes = Uint8Array.from(atob(icon), c => c.charCodeAt(0));
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    await github(
      env,
      `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${folder}/icon.png`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "DAPP Builder: upload app icon",
          content: btoa(binary),
          branch: env.GITHUB_BRANCH || "main"
        })
      }
    );
  }

  await github(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/build-apk.yml/dispatches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: env.GITHUB_BRANCH || "main",
        inputs: { build_id: buildId }
      })
    }
  );

  return json({ ok: true, build_id: buildId });
}

async function findBuild(env, buildId) {
  const data = await github(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs?per_page=100`
  );

  return data.workflow_runs.find(run =>
    (run.display_title || "").includes(buildId)
  ) || null;
}

async function getStatus(env, buildId) {
  if (!buildId) return json({ error: "build_id wajib diisi." }, 400);

  const run = await findBuild(env, buildId);

  if (!run) {
    return json({ status: "queued", conclusion: null });
  }

  return json({
    status: run.status,
    conclusion: run.conclusion
  });
}

async function extractApk(zipBytes) {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let eocd = -1;

  for (let i = zipBytes.length - 22; i >= Math.max(0, zipBytes.length - 65558); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }

  if (eocd < 0) throw new Error("Arsip ZIP tidak valid.");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);

    const name = new TextDecoder().decode(
      zipBytes.subarray(offset + 46, offset + 46 + nameLength)
    );

    if (name.endsWith(".apk")) {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zipBytes.subarray(start, start + compressedSize);

      if (method === 0) return compressed;

      if (method === 8) {
        const stream = new Blob([compressed])
          .stream()
          .pipeThrough(new DecompressionStream("deflate-raw"));

        return new Uint8Array(await new Response(stream).arrayBuffer());
      }

      throw new Error("Metode kompresi APK tidak didukung.");
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  throw new Error("File APK tidak ditemukan dalam artifact.");
}

async function downloadApk(env, buildId) {
  const run = await findBuild(env, buildId);

  if (!run || run.status !== "completed" || run.conclusion !== "success") {
    return json({ error: "Build belum selesai atau gagal." }, 409);
  }

  const data = await github(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs/${run.id}/artifacts`
  );

  const artifact = data.artifacts.find(item =>
    item.name === "DAPP-BUILDER-APK" && !item.expired
  );

  if (!artifact) return json({ error: "Artifact APK belum tersedia." }, 404);

  const archive = await fetch(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/artifacts/${artifact.id}/zip`,
    {
      headers: {
        "Authorization": "Bearer " + env.GITHUB_TOKEN,
        "Accept": "application/vnd.github+json",
        "User-Agent": "DAPP-BUILDER"
      }
    }
  );

  if (!archive.ok) {
    return json({ error: "Gagal mengambil artifact dari GitHub." }, 502);
  }

  const zipBytes = new Uint8Array(await archive.arrayBuffer());
  const apk = await extractApk(zipBytes);

  return new Response(apk, {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Disposition": 'attachment; filename="app-debug.apk"',
      "Cache-Control": "no-store"
    }
  });
}

  export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (origin && origin !== "https://dapp-2-apk.vercel.app") {
      return json({
        ok: false,
        error: "Origin tidak diizinkan."
      }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
      return json({ ok: false, error: "Konfigurasi GitHub Worker belum lengkap." }, 500);
    }

    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/build") {
        return await startBuild(request, env);
      }

      if (request.method === "GET" && url.pathname === "/status") {
        return await getStatus(env, url.searchParams.get("build_id"));
      }

      if (request.method === "GET" && url.pathname === "/download") {
        return await downloadApk(env, url.searchParams.get("build_id"));
      }

      return json({ ok: false, error: "Endpoint tidak ditemukan." }, 404);
    } catch (error) {
      return json({
        ok: false,
        error: error.message || "Terjadi kesalahan pada Worker."
      }, 500);
    }
  }
};
