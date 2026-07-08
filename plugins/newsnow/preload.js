/**
 * NewsNow preload — 远程 API 请求（Node.js https）
 */
const https = require("node:https");
const http = require("node:http");

function buildHeaders(origin) {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    Referer: `${origin}/`,
  };
}

function parseErrorMessage(body, statusCode) {
  try {
    const json = JSON.parse(body);
    if (json.message) return String(json.message);
    if (json.statusMessage) return String(json.statusMessage);
  } catch {
    // ignore
  }
  if (statusCode === 500) return "源站暂不可用";
  return `HTTP ${statusCode}`;
}

function requestJson(urlString) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (error) {
      reject(error);
      return;
    }

    const origin = `${url.protocol}//${url.host}`;
    const lib = url.protocol === "https:" ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: buildHeaders(origin),
    };

    const req = lib.request(options, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        requestJson(new URL(res.headers.location, urlString).toString()).then(resolve).catch(reject);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(parseErrorMessage(body, res.statusCode)));
          return;
        }
        try {
          const json = JSON.parse(body);
          if (json.error) {
            reject(new Error(json.message || json.statusMessage || "请求失败"));
            return;
          }
          resolve(json);
        } catch (error) {
          reject(new Error("响应不是有效 JSON"));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("请求超时"));
    });
    req.setTimeout(20000);
    req.end();
  });
}

window.newsnowServices = {
  fetchSource(apiUrl) {
    return requestJson(apiUrl);
  },
};
