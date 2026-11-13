const ADMIN_PASSWORD_SALT = "cbpd-admin-v1:";
const ADMIN_PASSWORD_HASH = "ccf315f9ee4a425181caa673141dfee3875e84405e775f182aab34e2771231ce";
const LIVE_ORIGIN = "https://cbpd-calendar.vercel.app";
const ATTACHMENT_BUCKET = "calendar-attachments";
const DATABASE_QUOTA_BYTES = 500 * 1024 * 1024;
const STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;
type TaskRow = { id: string; task_type?: string; attachments?: unknown };

function isAllowedOrigin(origin: string): boolean {
  return origin === LIVE_ORIGIN
    || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(origin: string, status: number, body: JsonRecord): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function normalizePeople(value: unknown): Array<{ name: string; position: string }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new Error("ต้องมีผู้รับผิดชอบ 1–50 คน");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("รูปแบบรายชื่อไม่ถูกต้อง");
    const record = item as JsonRecord;
    const name = String(record.name ?? "").trim();
    const position = String(record.position ?? "").trim();
    if (!name || name.length > 200 || position.length > 200) throw new Error("ชื่อหรือตำแหน่งไม่ถูกต้อง");
    const key = name.toLocaleLowerCase("th");
    if (seen.has(key)) throw new Error("พบชื่อซ้ำ");
    seen.add(key);
    return { name, position };
  });
}

function normalizeTaskTypes(value: unknown): Array<{ key: string; label: string; color: string }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) {
    throw new Error("ต้องมีประเภทงาน 1–30 ประเภท");
  }
  const keys = new Set<string>();
  const labels = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("รูปแบบประเภทงานไม่ถูกต้อง");
    const record = item as JsonRecord;
    const key = String(record.key ?? "").trim().toLowerCase();
    const label = String(record.label ?? "").trim();
    const color = String(record.color ?? "").trim().toUpperCase();
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(key) || !label || label.length > 100 || !/^#[0-9A-F]{6}$/.test(color)) {
      throw new Error("ชื่อ รหัส หรือสีของประเภทงานไม่ถูกต้อง");
    }
    const labelKey = label.toLocaleLowerCase("th");
    if (keys.has(key) || labels.has(labelKey)) throw new Error("พบประเภทงานซ้ำ");
    keys.add(key);
    labels.add(labelKey);
    return { key, label, color };
  });
}

function getServiceConfig(): { supabaseUrl: string; serviceRoleKey: string } {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRoleKey) throw new Error("ระบบหลังบ้านยังไม่พร้อม");
  return { supabaseUrl, serviceRoleKey };
}

function serviceHeaders(serviceRoleKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "apikey": serviceRoleKey,
    "Authorization": `Bearer ${serviceRoleKey}`,
    ...extra,
  };
}

async function saveSetting(
  supabaseUrl: string,
  serviceRoleKey: string,
  key: string,
  value: unknown,
): Promise<void> {
  const response = await fetch(`${supabaseUrl}/rest/v1/calendar_settings?on_conflict=key`, {
    method: "POST",
    headers: serviceHeaders(serviceRoleKey, {
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates,return=minimal",
    }),
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) {
    console.error("calendar_settings upsert failed", response.status, await response.text());
    throw new Error("บันทึกการตั้งค่าไม่สำเร็จ");
  }
}

async function fetchAllTasks(
  supabaseUrl: string,
  serviceRoleKey: string,
  filters = "",
  select = "id,task_type,attachments",
): Promise<TaskRow[]> {
  const rows: TaskRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const query = `select=${encodeURIComponent(select)}&order=start_date.asc&limit=${pageSize}&offset=${offset}${filters}`;
    const response = await fetch(`${supabaseUrl}/rest/v1/calendar_tasks?${query}`, {
      headers: serviceHeaders(serviceRoleKey),
    });
    if (!response.ok) {
      console.error("calendar_tasks fetch failed", response.status, await response.text());
      throw new Error("ตรวจสอบข้อมูลงานไม่สำเร็จ");
    }
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error("รูปแบบข้อมูลงานไม่ถูกต้อง");
    rows.push(...page as TaskRow[]);
    if (page.length < pageSize) break;
  }
  return rows;
}

function toIsoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parsePeriod(body: JsonRecord): { year: number; month: number | null; startDate: string; endDate: string } {
  const year = Number(body.year);
  const month = body.scope === "year" ? null : Number(body.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2257) throw new Error("ปีไม่ถูกต้อง");
  if (month !== null && (!Number.isInteger(month) || month < 1 || month > 12)) throw new Error("เดือนไม่ถูกต้อง");
  if (month === null) return { year, month, startDate: toIsoDate(year, 1, 1), endDate: toIsoDate(year + 1, 1, 1) };
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return { year, month, startDate: toIsoDate(year, month, 1), endDate: toIsoDate(nextYear, nextMonth, 1) };
}

function periodFilters(period: { startDate: string; endDate: string }): string {
  return `&start_date=gte.${encodeURIComponent(period.startDate)}&start_date=lt.${encodeURIComponent(period.endDate)}`;
}

function collectAttachments(tasks: TaskRow[]): Array<{ bucket: string; path: string; size: number }> {
  const seen = new Set<string>();
  const files: Array<{ bucket: string; path: string; size: number }> = [];
  for (const task of tasks) {
    const attachments = Array.isArray(task.attachments) ? task.attachments : [];
    for (const item of attachments) {
      if (!item || typeof item !== "object") continue;
      const record = item as JsonRecord;
      const path = String(record.storagePath ?? record.path ?? "").replace(/^\/+/, "");
      const bucket = String(record.bucket ?? ATTACHMENT_BUCKET);
      const key = `${bucket}\n${path}`;
      if (!path || seen.has(key)) continue;
      seen.add(key);
      files.push({ bucket, path, size: Math.max(0, Number(record.size) || 0) });
    }
  }
  return files;
}

async function deleteStorageFiles(
  supabaseUrl: string,
  serviceRoleKey: string,
  files: Array<{ bucket: string; path: string }>,
): Promise<void> {
  const byBucket = new Map<string, string[]>();
  for (const file of files) byBucket.set(file.bucket, [...(byBucket.get(file.bucket) || []), file.path]);
  for (const [bucket, paths] of byBucket) {
    for (let index = 0; index < paths.length; index += 1000) {
      const prefixes = paths.slice(index, index + 1000);
      const response = await fetch(`${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`, {
        method: "DELETE",
        headers: serviceHeaders(serviceRoleKey, { "Content-Type": "application/json" }),
        body: JSON.stringify({ prefixes }),
      });
      if (!response.ok) {
        console.error("storage delete failed", response.status, await response.text());
        throw new Error("ลบไฟล์แนบไม่สำเร็จ จึงยังไม่ได้ลบข้อมูลงาน");
      }
    }
  }
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin") || "";
  if (!isAllowedOrigin(origin)) return jsonResponse(LIVE_ORIGIN, 403, { success: false, message: "ไม่อนุญาตให้เรียกจากเว็บไซต์นี้" });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== "POST") return jsonResponse(origin, 405, { success: false, message: "Method not allowed" });

  let body: JsonRecord;
  try { body = await request.json(); }
  catch { return jsonResponse(origin, 400, { success: false, message: "รูปแบบคำขอไม่ถูกต้อง" }); }

  const password = String(body.password ?? "");
  const receivedHash = await sha256Hex(ADMIN_PASSWORD_SALT + password);
  if (!safeEqual(receivedHash, ADMIN_PASSWORD_HASH)) {
    await new Promise((resolve) => setTimeout(resolve, 550));
    return jsonResponse(origin, 401, { success: false, message: "รหัสผ่าน Admin ไม่ถูกต้อง" });
  }
  if (body.action === "verify") return jsonResponse(origin, 200, { success: true });

  let config: { supabaseUrl: string; serviceRoleKey: string };
  try { config = getServiceConfig(); }
  catch (error) { return jsonResponse(origin, 500, { success: false, message: error instanceof Error ? error.message : "ระบบหลังบ้านยังไม่พร้อม" }); }
  const { supabaseUrl, serviceRoleKey } = config;

  try {
    if (body.action === "save") {
      const people = normalizePeople(body.people);
      await saveSetting(supabaseUrl, serviceRoleKey, "responsible_people", people);
      return jsonResponse(origin, 200, { success: true, people });
    }

    if (body.action === "save-task-types") {
      const taskTypes = normalizeTaskTypes(body.taskTypes);
      const tasks = await fetchAllTasks(supabaseUrl, serviceRoleKey, "", "id,task_type");
      const configuredKeys = new Set(taskTypes.map((item) => item.key));
      const missingKeys = [...new Set(tasks.map((task) => String(task.task_type || "other")))]
        .filter((key) => !configuredKeys.has(key));
      if (missingKeys.length) throw new Error("ยังลบประเภทที่มีงานใช้งานอยู่ไม่ได้");
      await saveSetting(supabaseUrl, serviceRoleKey, "task_types", taskTypes);
      return jsonResponse(origin, 200, { success: true, taskTypes });
    }

    if (body.action === "usage") {
      const response = await fetch(`${supabaseUrl}/rest/v1/admin_system_usage?select=database_bytes,storage_bytes,file_count,task_count,measured_at&limit=1`, {
        headers: serviceHeaders(serviceRoleKey),
      });
      if (!response.ok) {
        console.error("usage query failed", response.status, await response.text());
        throw new Error("อ่านพื้นที่ใช้งานไม่สำเร็จ");
      }
      const rows = await response.json();
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) throw new Error("ไม่พบข้อมูลพื้นที่ใช้งาน");
      return jsonResponse(origin, 200, {
        success: true,
        usage: {
          databaseBytes: Number(row.database_bytes || 0),
          databaseQuotaBytes: DATABASE_QUOTA_BYTES,
          storageBytes: Number(row.storage_bytes || 0),
          storageQuotaBytes: STORAGE_QUOTA_BYTES,
          fileCount: Number(row.file_count || 0),
          taskCount: Number(row.task_count || 0),
          measuredAt: row.measured_at,
        },
      });
    }

    if (body.action === "preview-delete-period" || body.action === "delete-period") {
      const period = parsePeriod(body);
      const tasks = await fetchAllTasks(supabaseUrl, serviceRoleKey, periodFilters(period));
      const files = collectAttachments(tasks);
      const summary = {
        taskCount: tasks.length,
        fileCount: files.length,
        fileBytes: files.reduce((sum, file) => sum + file.size, 0),
      };
      if (body.action === "preview-delete-period") return jsonResponse(origin, 200, { success: true, summary });
      if (!tasks.length) return jsonResponse(origin, 200, { success: true, deleted: summary });

      await deleteStorageFiles(supabaseUrl, serviceRoleKey, files);
      const deleteResponse = await fetch(
        `${supabaseUrl}/rest/v1/calendar_tasks?start_date=gte.${encodeURIComponent(period.startDate)}&start_date=lt.${encodeURIComponent(period.endDate)}`,
        {
          method: "DELETE",
          headers: serviceHeaders(serviceRoleKey, { "Prefer": "return=minimal" }),
        },
      );
      if (!deleteResponse.ok) {
        console.error("calendar_tasks delete failed", deleteResponse.status, await deleteResponse.text());
        throw new Error("ลบไฟล์แล้ว แต่ลบข้อมูลงานไม่สำเร็จ กรุณาติดต่อผู้ดูแลระบบ");
      }
      return jsonResponse(origin, 200, { success: true, deleted: summary });
    }

    return jsonResponse(origin, 400, { success: false, message: "ไม่รู้จักคำสั่งนี้" });
  } catch (error) {
    console.error(error);
    return jsonResponse(origin, 400, {
      success: false,
      message: error instanceof Error ? error.message : "ดำเนินการไม่สำเร็จ",
    });
  }
});
