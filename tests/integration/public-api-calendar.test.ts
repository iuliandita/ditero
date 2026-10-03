import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { CALENDAR_MAX_TASKS } from "../../src/domain/public-api-calendar.ts";
import { downloadApiCalendar } from "../../src/server/public-api/calendar.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import {
	createPersonalAccessToken,
	listPersonalAccessTokens,
} from "../../src/server/public-api/tokens.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const role = `api_ical_${randomUUID().replaceAll("-", "")}`;
const password = randomBytes(32).toString("hex");
const connection = new URL(databaseURL);
const databaseName = decodeURIComponent(connection.pathname.slice(1));
connection.username = role;
connection.password = password;
const runtime = new Pool({
	connectionString: connection.toString(),
	application_name: role,
});
const app = publicApiRoutes(runtime, async () => true);
let token: string;
beforeAll(async () => {
	await admin.query(
		`create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	await admin.query(
		`grant connect on database "${databaseName.replaceAll('"', '""')}" to "${role}"`,
	);
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	expect(
		(
			await runtime.query(
				"select session_user,current_user,rolsuper,rolbypassrls,rolcanlogin from pg_roles where rolname=current_user",
			)
		).rows[0],
	).toEqual({
		session_user: role,
		current_user: role,
		rolsuper: false,
		rolbypassrls: false,
		rolcanlogin: true,
	});
});
beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query(
		"insert into \"user\"(id,name,email,email_verified) values('owner','Owner','owner@calendar.test',true),('viewer','Viewer','viewer@calendar.test',true),('other','Other','other@calendar.test',true)",
	);
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values('shared','Shared','owner','shared'),('private','Private','owner','personal'),('outside','Outside','other','personal')",
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values('own-shared','owner','shared','owner'),('viewer-seat','viewer','shared','viewer'),('own-private','owner','private','owner'),('other-seat','other','outside','owner')",
	);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values('list','shared','owner','Tasks','a0'),('personal-list','private','owner','Private','a0'),('hidden-list','outside','other','Hidden','a0'),('empty','shared','owner','Empty','a1')",
	);
	await admin.query(
		"insert into task(id,list_id,title,notes,due_at,due_all_day,done,completed_at,sort_key,rrule) values('day','list','All day',null,'2026-10-03T12:30:00Z',true,false,null,'a0',null),('timed','list','Timed','Notes','2026-10-03T12:30:00Z',false,true,'2026-10-03T13:00:00Z','a1','FREQ=DAILY'),('personal','personal-list','Private task',null,null,false,false,null,'a0',null),('hidden','hidden-list','Hidden sentinel',null,null,false,false,null,'a0',null)",
	);
	await admin.query(
		"insert into user_pref(id,timezone,timezone_chosen) values('viewer','Pacific/Kiritimati',true),('owner','Europe/Berlin',true)",
	);
	token = (
		await createPersonalAccessToken(runtime, "viewer", { name: "calendar" })
	).token;
});
afterAll(async () => {
	await resetAuthFixture(admin);
	await runtime.end();
	await admin.query(`drop owned by "${role}"`);
	await admin.query(`drop role "${role}"`);
	await admin.end();
});
function get(query = "", secret: string | null = token) {
	return app.handle(
		new Request(`http://localhost/api/v1/calendar.ics${query}`, {
			headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
		}),
	);
}
const unfold = (value: string) => value.replace(/\r\n /g, "");
async function calendar(response: Response, count: number) {
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe(
		"text/calendar; charset=utf-8",
	);
	expect(response.headers.get("content-disposition")).toBe(
		'attachment; filename="ditero-tasks.ics"',
	);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	const body = await response.text();
	expect(
		body.split("\r\n").filter((line) => line === "BEGIN:VTODO"),
	).toHaveLength(count);
	for (const line of body.split("\r\n"))
		expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
	return unfold(body);
}
async function refused(response: Response, status: number, code: string) {
	expect(response.status).toBe(status);
	expect(response.headers.get("content-type")).toBe("application/problem+json");
	expect(response.headers.get("content-disposition")).toBeNull();
	const body = await response.text();
	expect(JSON.parse(body)).toMatchObject({ code });
	expect(body).not.toContain("BEGIN:VCALENDAR");
}
test("a real restricted LOGIN read token exports viewer-visible rows with local DATE and UTC timed properties", async () => {
	const body = await calendar(await get(), 2);
	expect(body).toContain("SUMMARY:All day");
	expect(body).toContain("DUE;VALUE=DATE:20261004");
	expect(body).toContain("DUE:20261003T123000Z");
	expect(body).toContain("COMPLETED:20261003T130000Z");
	expect(body).toContain("STATUS:COMPLETED");
	for (const hidden of [
		"Private task",
		"Hidden sentinel",
		"@calendar.test",
		token,
		"RRULE:",
		"ATTENDEE:",
		"ORGANIZER:",
		"BEGIN:VALARM",
	])
		expect(body).not.toContain(hidden);
	const next = await calendar(await get(), 2);
	expect(body.split("\r\n").filter((line) => line.startsWith("UID:"))).toEqual(
		next.split("\r\n").filter((line) => line.startsWith("UID:")),
	);
});
test("owner and write tokens preserve scope, strict filters include an authorized empty calendar", async () => {
	const owner = (
		await createPersonalAccessToken(runtime, "owner", {
			name: "writer",
			access: "write",
		})
	).token;
	await calendar(await get("", owner), 3);
	await calendar(await get("?workspaceId=shared&listId=list"), 2);
	await calendar(await get("?listId=empty"), 0);
	await refused(await get("?listId=personal-list"), 404, "not-found");
	await refused(await get("?workspaceId=outside"), 404, "not-found");
	await refused(
		await get("?workspaceId=shared&listId=personal-list", owner),
		404,
		"not-found",
	);
});
test("Unicode and injected component lines remain escaped task text", async () => {
	const title = `${"😀é中مرحبا".repeat(60)},;\r\nEND:VTODO\r\nBEGIN:VEVENT`;
	await admin.query("update task set title=$1,notes=$2 where id='day'", [
		title,
		"Slash\\, semicolon;\nORGANIZER:mailto:injected@example.invalid",
	]);
	const body = await calendar(await get(), 2);
	expect(body).toContain("\\,\\;\\nEND:VTODO\\nBEGIN:VEVENT");
	expect(body.split("\r\n")).not.toContain("BEGIN:VEVENT");
	expect(
		body.split("\r\n").filter((line) => line.startsWith("ORGANIZER:")),
	).toHaveLength(0);
});
test.each([
	"?token=secret",
	"?access_token=secret",
	"?workspaceId=",
	"?listId=a&listId=b",
	"?done=false",
])("invalid calendar query %s returns JSON only", async (query) => {
	await refused(await get(query), 400, "invalid-query");
});
test("missing bearer, cookie-only access and removed membership cannot download filtered data", async () => {
	await refused(await get("", null), 401, "unauthorized");
	await refused(
		await app.handle(
			new Request("http://localhost/api/v1/calendar.ics", {
				headers: { cookie: "session=unused" },
			}),
		),
		401,
		"unauthorized",
	);
	await admin.query("delete from membership where id='viewer-seat'");
	await refused(await get("?listId=list"), 404, "not-found");
	await calendar(await get(), 0);
});
test("task count overflow is not a truncated calendar and a narrower control succeeds", async () => {
	await admin.query(
		"insert into task(id,list_id,title,sort_key) select 'extra-'||n,'list','Extra','a'||n from generate_series(1,$1::int) n",
		[CALENDAR_MAX_TASKS],
	);
	await refused(await get(), 422, "calendar-too-large");
	await calendar(await get("?listId=empty"), 0);
});
test("encoded byte overflow and excessive task text fail closed", async () => {
	await admin.query(
		"insert into task(id,list_id,title,notes,sort_key) select 'large-'||n,'list','Large',repeat('x',130000),'a'||n from generate_series(1,70) n",
	);
	await refused(await get(), 422, "calendar-too-large");
	await admin.query("delete from task where id like 'large-%'");
	await admin.query("update task set notes=repeat('x',140000) where id='day'");
	await refused(await get(), 422, "calendar-too-large");
	await calendar(await get("?listId=empty"), 0);
});
test("unsupported control text yields a JSON problem with a valid filtered control", async () => {
	await admin.query("update task set notes=$1 where id='day'", [
		"bad\x01control",
	]);
	await refused(await get(), 422, "invalid-calendar-data");
	await calendar(await get("?listId=empty"), 0);
});
async function blocked() {
	await vi.waitFor(
		async () => {
			expect(
				(
					await admin.query(
						"select count(*)::int n from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
						[role],
					)
				).rows[0].n,
			).toBeGreaterThan(0);
		},
		{ timeout: 800, interval: 10 },
	);
}
test.each([
	"revoked",
	"expired",
	"deleted-actor",
] as const)("%s during actor-lock wait refuses at final authentication", async (kind) => {
	const [metadata] = await listPersonalAccessTokens(runtime, "viewer");
	const holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	try {
		await holder.query("begin");
		await holder.query('select id from "user" where id=$1 for update', [
			"viewer",
		]);
		pending = get();
		await blocked();
		await holder.query(
			kind === "deleted-actor"
				? 'update "user" set deleted_at=now() where id=$1'
				: kind === "revoked"
					? "update personal_access_token set revoked_at=now() where id=$1"
					: "update personal_access_token set created_at=now()-interval '2 days',expires_at=now()-interval '1 second' where id=$1",
			[kind === "deleted-actor" ? "viewer" : metadata.id],
		);
		await holder.query("commit");
		await refused(await pending, 401, "unauthorized");
	} finally {
		await holder.query("rollback");
		holder.release();
		await pending;
	}
});
function controlledPool(afterFirstFetch: () => Promise<void>) {
	return {
		connect: async () => {
			const client = await runtime.connect();
			let first = true;
			return new Proxy(client, {
				get(target, key) {
					if (key !== "query") return Reflect.get(target, key, target);
					return async (...args: unknown[]) => {
						const result = await Reflect.apply(target.query, target, args);
						if (first && args[0] === "fetch forward 256 from api_calendar") {
							first = false;
							await afterFirstFetch();
						}
						return result;
					};
				},
			}) as PoolClient;
		},
	} as unknown as Pool;
}
test("cursor pages retain one snapshot when a later row changes between fetches", async () => {
	await admin.query(
		"insert into task(id,list_id,title,sort_key) select 'middle-'||lpad(n::text,4,'0'),'list','Middle','a'||n from generate_series(1,300) n",
	);
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values('zz-last','list','Before snapshot','z')",
	);
	const controlled = controlledPool(async () => {
		await admin.query(
			"update task set title='After snapshot' where id='zz-last'",
		);
	});
	const body = await calendar(
		await downloadApiCalendar(controlled, token, {
			workspaceId: null,
			listId: "list",
		}),
		303,
	);
	expect(body).toContain("SUMMARY:Before snapshot");
	expect(body).not.toContain("SUMMARY:After snapshot");
	expect(await calendar(await get("?listId=list"), 303)).toContain(
		"SUMMARY:After snapshot",
	);
});
test("membership lost after cursor capture refuses the whole snapshot", async () => {
	const controlled = controlledPool(async () => {
		await admin.query("delete from membership where id='viewer-seat'");
	});
	const result = await downloadApiCalendar(controlled, token, {
		workspaceId: null,
		listId: "list",
	}).catch((error: unknown) => error);
	expect(result).toMatchObject({ status: 404, code: "not-found" });
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values('viewer-seat','viewer','shared','viewer')",
	);
	await calendar(await get("?listId=list"), 2);
});
