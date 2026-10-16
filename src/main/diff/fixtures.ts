/** The design's worked example (acme/api#812), plus a lockfile and a rename. */
export const SAMPLE_DIFF = `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 1111111..2222222 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -38,7 +38,10 @@ export async function refreshSession(req: Request) {
   const token = req.cookies.refresh;
   if (!token) return null;
-  const session = await store.get(token);
-  if (!session) throw new AuthError("refresh expired");
+  const session = (await store.get(token)) ?? memo.get(token);
+  if (!session) return null;
+  memo.set(token, session);
   session.expiresAt = Date.now() + SESSION_TTL;
   await store.put(token, session);
+  metrics.increment("session.refresh");
+  // TODO: evict memo on logout
   return session;
diff --git a/src/auth/memo.ts b/src/auth/memo.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/auth/memo.ts
@@ -0,0 +1,7 @@
+import type { Session } from "./types";
+
+const entries = new Map<string, Session>();
+export const memo = {
+  get: (k: string) => entries.get(k),
+  set: (k: string, s: Session) => entries.set(k, s),
+};
\\ No newline at end of file
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 4444444..5555555 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1,2 +1,2 @@
-lockfileVersion: '6.0'
+lockfileVersion: '9.0'
 settings:
diff --git a/docs/old name.md b/docs/new name.md
similarity index 100%
rename from docs/old name.md
rename to docs/new name.md
diff --git a/logo.png b/logo.png
index 6666666..7777777 100644
Binary files a/logo.png and b/logo.png differ
`;
