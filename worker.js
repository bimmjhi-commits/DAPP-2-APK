
const API = "https://api.github.com";
const WORKFLOW = "build-apk.yml";
const ARTIFACT_NAME = "DAPP-BUILDER-APK";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";

    const headers = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Turnstile-Token",
      "Access-Control-Max-Age": "86400",
      "Content-Type": "application/json"
    };

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers });

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (allowedOrigin !== "*" && origin !== allowedOrigin) {
      return json({
        ok: false,
        success: false,
        error: "Origin tidak diizinkan."
      }, 403);
    }

    if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
      return json({
        ok: false,
        success: false,
        error: "Konfigurasi GitHub Worker belum lengkap."
      }, 500);
    }

    const owner = env.GITHUB_OWNER;
    const repo = env.GITHUB_REPO;
    const branch = env.GITHUB_BRANCH || "main";

    const ghHeaders = {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "DAPP-BUILDER"
    };

    async function github(path, options = {}) {
      const response = await fetch(API + path, {
        ...options,
        headers: {
          ...ghHeaders,
          ...(options.headers || {})
        }
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `GitHub API ${response.status}: ${detail.slice(0, 500)}`
        );
      }

      if (response.status === 204) return null;
      return response.json();
    }

    function encodeBase64(value) {
      const bytes = new TextEncoder().encode(value);
      let binary = "";

      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }

      return btoa(binary);
    }

    async function uploadFile(path, content) {
      return github(
        `/repos/${owner}/${repo}/contents/${path}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json"
          },
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

      return result.workflow_runs.find(run =>
        String(run.display_title || "").includes(buildId)
      );
    }

    function validBuildId(id) {
      return typeof id === "string" &&
        /^[0-9a-f-]{36}$/i.test(id);
    }

    async function getArtifact(buildId) {
      const run = await findBuild(buildId);

      if (!run) {
        return { run: null, artifact: null };
      }

      if (run.status !== "completed" || run.conclusion !== "success") {
        return { run, artifact: null };
      }

      const result = await github(
        `/repos/${owner}/${repo}/actions/runs/${run.id}/artifacts`
      );

      const artifact = result.artifacts.find(item =>
        item.name === ARTIFACT_NAME && !item.expired
      );

      return { run, artifact: artifact || null };
    }

    // Extract the APK file from GitHub's ZIP artifact.
    async function extractApk(zipBuffer) {
      const bytes = new Uint8Array(zipBuffer);
      const view = new DataView(zipBuffer);
      const decoder = new TextDecoder();

      let eocd = -1;
      const min = Math.max(0, bytes.length - 65557);

      for (let i = bytes.length - 22; i >= min; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
          eocd = i;
          break;
        }
      }

      if (eocd < 0) {
        throw new Error("Format ZIP artifact tidak valid.");
      }

      const entries = view.getUint16(eocd + 10, true);
      let offset = view.getUint32(eocd + 16, true);

      for (let i = 0; i < entries; i++) {
        if (view.getUint32(offset, true) !== 0x02014b50) {
          throw new Error("Struktur ZIP tidak valid.");
        }

        const method = view.getUint16(offset + 10, true);
        const compressedSize = view.getUint32(offset + 20, true);
        const nameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        const localOffset = view.getUint32(offset + 42, true);

        const name = decoder.decode(
          bytes.slice(offset + 46, offset + 46 + nameLength)
        );

        if (name.toLowerCase().endsWith(".apk")) {
          if (view.getUint32(localOffset, true) !== 0x04034b50) {
            throw new Error("File APK di dalam ZIP tidak valid.");
          }

          const localNameLength = view.getUint16(localOffset + 26, true);
          const localExtraLength = view.getUint16(localOffset + 28, true);

          const dataStart =
            localOffset + 30 + localNameLength + localExtraLength;

          const compressed = bytes.slice(
            dataStart,
            dataStart + compressedSize
          );

          if (method === 0) {
            return compressed;
          }

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

    const url = new URL(request.url);

    try {
      // BUILD APK
      if (url.pathname === "/build" && request.method === "POST") {
        const payload = await request.json();

        const data = payload.config &&
          typeof payload.config === "object"
          ? payload.config
          : payload;

        const appName = String(data.appName || "My App")
          .trim()
          .slice(0, 50) || "My App";

        const packageName = String(
          data.packageName || "com.dapp.myapp"
        ).trim();

        const version = String(data.version || "1.0")
          .trim()
          .slice(0, 30) || "1.0";

        const sourceType = data.sourceType || "url";
        const targetUrl = String(data.url || "").trim();

        const htmlSource = typeof payload.html === "string"
          ? payload.html
          : (typeof data.html === "string" ? data.html : "");

        const iconSource = payload.logoDataUrl ||
          payload.iconBase64 ||
          data.logoDataUrl ||
          data.iconBase64 ||
          "";

        if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){1,5}$/.test(packageName)) {
          return json({
            ok: false,
            success: false,
            error: "Package Name tidak valid."
          }, 400);
        }

        if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,29}$/.test(version)) {
          return json({
            ok: false,
            success: false,
            error: "Versi aplikasi tidak valid."
          }, 400);
        }

        if (!["url", "html"].includes(sourceType)) {
          return json({
            ok: false,
            success: false,
            error: "Jenis sumber tidak valid."
          }, 400);
        }

        if (sourceType === "url") {
          let parsed;

          try {
            parsed = new URL(targetUrl);
          } catch {
            return json({
              ok: false,
              success: false,
              error: "URL website tidak valid."
            }, 400);
          }

          if (!["http:", "https:"].includes(parsed.protocol)) {
            return json({
              ok: false,
              success: false,
              error: "Gunakan URL HTTP atau HTTPS."
            }, 400);
          }
        }

        if (sourceType === "html" && !htmlSource.trim()) {
          return json({
            ok: false,
            success: false,
            error: "Kode HTML belum dikirim."
          }, 400);
        }

        let icon = "";

        if (iconSource) {
          icon = String(iconSource).replace(
            /^data:image\/png;base64,/i,
            ""
          );

          if (
            icon.length > 5 * 1024 * 1024 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(icon)
          ) {
            return json({
              ok: false,
              success: false,
              error: "Format atau ukuran logo tidak valid."
            }, 400);
          }
        }

        const orientation = ["sensor", "portrait", "landscape"]
          .includes(data.orientation)
          ? data.orientation
          : "sensor";

        const buildId = crypto.randomUUID();

        const config = {
          appName,
          packageName,
          version,
          sourceType,
          url: sourceType === "url" ? targetUrl : "",
          orientation,
          permissions: {
            internet: data.permissions?.internet !== false,
            camera: Boolean(data.permissions?.camera),
            location: Boolean(data.permissions?.location)
          },
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
            encodeBase64(htmlSource)
          );
        }

        if (icon) {
          await uploadFile(
            `build-requests/${buildId}/icon.png`,
            icon
          );
        }

        await github(
          `/repos/${owner}/${repo}/actions/workflows/${WORKFLOW}/dispatches`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              ref: branch,
              inputs: {
                build_id: buildId
              }
            })
          }
        );

        return json({
          ok: true,
          success: true,
          build_id: buildId,
          message: "Permintaan build berhasil dikirim."
        }, 202);
      }

      // CHECK BUILD STATUS
      if (url.pathname === "/status" && request.method === "GET") {
        const buildId = url.searchParams.get("build_id");

        if (!validBuildId(buildId)) {
          return json({
            ok: false,
            success: false,
            error: "Build ID tidak valid."
          }, 400);
        }

        const result = await getArtifact(buildId);
        const run = result.run;

        if (!run) {
          return json({
            ok: true,
            success: true,
            build_id: buildId,
            status: "queued",
            conclusion: null
          });
        }

        return json({
          ok: true,
          success: true,
          build_id: buildId,
          status: run.status,
          conclusion: run.conclusion,
          artifact_ready: Boolean(result.artifact),
          download_endpoint: result.artifact
            ? `/download?build_id=${buildId}`
            : null
        });
      }

      // DOWNLOAD APK
      if (
        (url.pathname === "/download" || url.pathname === "/artifact") &&
        request.method === "GET"
      ) {
        const buildId = url.searchParams.get("build_id");

        if (!validBuildId(buildId)) {
          return json({
            ok: false,
            success: false,
            error: "Build ID tidak valid."
          }, 400);
        }

        const result = await getArtifact(buildId);

        if (!result.run) {
          return json({
            ok: false,
            success: false,
            error: "Build tidak ditemukan."
          }, 404);
        }

        if (
          result.run.status !== "completed" ||
          result.run.conclusion !== "success"
        ) {
          return json({
            ok: false,
            success: false,
            error: "Build belum selesai atau gagal."
          }, 409);
        }

        if (!result.artifact) {
          return json({
            ok: false,
            success: false,
            error: "Artifact APK belum tersedia."
          }, 404);
        }

        const archiveResponse = await fetch(
          result.artifact.archive_download_url,
          {
            headers: ghHeaders,
            redirect: "manual"
          }
        );

        let zipResponse = archiveResponse;

        if ([301, 302, 303, 307, 308].includes(archiveResponse.status)) {
          const location = archiveResponse.headers.get("Location");

          if (!location) {
            throw new Error("Link unduhan artifact tidak tersedia.");
          }

          zipResponse = await fetch(location);
        }

        if (!zipResponse.ok) {
          throw new Error("Gagal mengambil ZIP artifact dari GitHub.");
        }

        const zipBuffer = await zipResponse.arrayBuffer();
        const apkBytes = await extractApk(zipBuffer);

        return new Response(apkBytes, {
          status: 200,
          headers: {
            ...headers,
            "Content-Type": "application/vnd.android.package-archive",
            "Content-Disposition": 'attachment; filename="app-debug.apk"',
            "Content-Length": String(apkBytes.byteLength),
            "Cache-Control": "no-store"
          }
        });
      }

      return json({
        ok: true,
        success: true,
        name: "DAPP BUILDER API",
        endpoints: ["/build", "/status", "/download"]
      });

    } catch (error) {
      return json({
        ok: false,
        success: false,
        error: error.message || "Terjadi kesalahan pada Worker."
      }, 500);
    }
  }
};
