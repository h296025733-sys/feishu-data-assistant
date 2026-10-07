for (const handle of ["tjones955", "formidablyfrugal", "murdock032", "caroljkarcsak"]) {
  try {
    const response = await fetch(`https://www.tiktok.com/@${handle}`, {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(18000),
    });
    const html = await response.text();
    const raw = /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
    const data = raw ? JSON.parse(raw) : null;
    const user = data?.__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo?.user;
    const info = { handle, status: response.status, bytes: html.length,
      resolvedHandle: user?.uniqueId ?? null, avatarLarger: !!user?.avatarLarger,
      avatarMedium: !!user?.avatarMedium, avatarThumb: !!user?.avatarThumb,
      captcha: html.toLowerCase().includes("captcha") };
    console.log(JSON.stringify(info));
  } catch (error) { console.log(JSON.stringify({ handle, error: String(error) })); }
}
