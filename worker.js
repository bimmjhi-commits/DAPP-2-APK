
const API = "https://api.github.com";
const WORKFLOW = "build-apk.yml";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";

    const headers = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json"
    };

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers });

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    if (allowedOrigin !== "*" && origin !== allowedOrigin) {
      return json({ success: false, error: "Origin not allowed" }, 403);
    }

    if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
      return json({ success: false, error: "Worker secrets belum lengkap" }, 500);
    }

    const ghHeaders = {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "DAPP-BUILDER"
    };

    const owner = env.GITHUB_OWNER;
    const repo = env.GITHUB_REPO;
    const branch = env.GITHUB_BRANCH || "main";

    async function github(path, options = {}) {
      const response = await fetch(`${API}${path}`, {
        ...options,
        headers: {
          ...ghHeaders,
          ...(options.headers || {})
        }
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`GitHub API ${response.status}: ${detail}`);
      }

      if (response.status === 204) return null;
      return response.json();
    }

    function encodeBase64(value) {
      const bytes = new TextEncoder().encode(value);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    }

    async function uploadFile(path, content) {
      return github(
        `/repos/${owner}/${repo}/contents/${path}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "DAPP BUILDER: Add build request",
            branch,
            content
          })
        }
      );
    }

    async function findBuild(buildId) {
      const result = await github(
        `/repos/${owner}/${repo}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=100`
      );

      return result.workflow_runs.find(
        run => (run.display_title || "").includes(buildId)
      );
    }

    const url = new URL(request.url);

    try {
      // CREATE BUILD
      if (url.pathname === "/build" && request.method === "POST") {
        const data = await request.json();

        const appName = String(data.appName || "My App").trim();
        const packageName = String(data.packageName || "com.dapp.myapp").trim();
        const version = String(data.version || "1.0").trim();
        const sourceType = data.sourceType || "url";
        const targetUrl = String(data.url || "").trim();

        if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){1,5}$/.test(packageName)) {
          return json({ success: false, error: "Package name tidak valid" }, 400);
        }

        if (!["url", "html"].includes(sourceType)) {
          return json({ success: false, error: "Source type tidak valid" }, 400);
        }

        if (sourceType === "url") {
          let parsed;
          try {
            parsed = new URL(targetUrl);
          } catch {
            return json({ success: false, error: "URL tidak valid" }, 400);
          }

          if (!["http:", "https:"].includes(parsed.protocol)) {
            return json({ success: false, error: "Gunakan URL HTTP atau HTTPS" }, 400);
          }
        }

        if (sourceType === "html" && typeof data.html !== "string") {
          return json({ success: false, error: "Kode HTML belum dikirim" }, 400);
        }

        const buildId = crypto.randomUUID();

        const config = {
          appName,
          packageName,
          version,
          sourceType,
          url: sourceType === "url" ? targetUrl : "",
          orientation: data.orientation || "sensor",
          permissions: data.permissions || {},
          fullscreen: Boolean(data.fullscreen),
          keepScreenOn: Boolean(data.keepScreenOn)
        };

        await uploadFile(
          `build-requests/${buildId}/config.json`,
          encodeBase64(JSON.stringify(config))
        );

        if (sourceType === "html") {
          await uploadFile(
            `build-requests/${buildId}/index.html`,
            encodeBase64(data.html)
          );
        }

        if (data.iconBase64) {
          const icon = String(data.iconBase64).replace(/^data:image\/png;base64,/, "");

          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(icon)) {
            return json({ success: false, error: "Format ikon tidak valid" }, 400);
          }

          await uploadFile(
            `build-requests/${buildId}/icon.png`,
            icon
          );
        }

        await github(
          `/repos/${owner}/${repo}/actions/workflows/${WORKFLOW}/dispatches`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ref: branch,
              inputs: { build_id: buildId }
            })
          }
        );

        return json({
          success: true,
          build_id: buildId,
          message: "Permintaan build berhasil dikirim"
        }, 202);
      }

      // CHECK BUILD STATUS
      if (url.pathname === "/status" && request.method === "GET") {
        const buildId = url.searchParams.get("build_id");

        if (!buildId || !/^[0-9a-f-]{36}$/i.test(buildId)) {
          return json({ success: false, error: "Build ID tidak valid" }, 400);
        }

        const run = await findBuild(buildId);

        if (!run) {
          return json({
            success: true,
            build_id: buildId,
            status: "queued"
          });
        }

        let artifact = null;

        if (run.status === "completed" && run.conclusion === "success") {
          const result = await github(
            `/repos/${owner}/${repo}/actions/runs/${run.id}/artifacts`
          );

          artifact = result.artifacts.find(
            item => item.name === "DAPP-BUILDER-APK" && !item.expired
          );
        }

        return json({
          success: true,
          build_id: buildId,
          status: run.status,
          conclusion: run.conclusion,
          artifact_ready: Boolean(artifact),
          download_endpoint: artifact
            ? `/artifact?build_id=${buildId}`
            : null
        });
      }

      // DOWNLOAD BUILD ARTIFACT ZIP
      if (url.pathname === "/artifact" && request.method === "GET") {
        const buildId = url.searchParams.get("build_id");

        if (!buildId || !/^[0-9a-f-]{36}$/i.test(buildId)) {
          return json({ success: false, error: "Build ID tidak valid" }, 400);
        }

        const run = await findBuild(buildId);

        if (!run || run.status !== "completed" || run.conclusion !== "success") {
          return json({ success: false, error: "Build belum selesai" }, 409);
        }

        const result = await github(
          `/repos/${owner}/${repo}/actions/runs/${run.id}/artifacts`
        );

        const artifact = result.artifacts.find(
          item => item.name === "DAPP-BUILDER-APK" && !item.expired
        );

        if (!artifact) {
          return json({ success: false, error: "APK belum tersedia" }, 404);
        }

        const download = await fetch(artifact.archive_download_url, {
          headers: ghHeaders,
          redirect: "manual"
        });

        if (download.status !== 302 && download.status !== 301) {
          return json({ success: false, error: "Gagal mengambil artifact" }, 502);
        }

        return Response.redirect(download.headers.get("Location"), 302);
      }

      return json({
        success: true,
        name: "DAPP BUILDER API",
        endpoints: ["/build", "/status", "/artifact"]
      });

    } catch (error) {
      return json({
        success: false,
        error: error.message
      }, 500);
    }
  }
};
