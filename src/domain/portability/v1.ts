export type PortableJson =
	| null
	| boolean
	| number
	| string
	| PortableJson[]
	| { [key: string]: PortableJson };

// Version 1 preserves source IDs and content, but is not a restorable backup.
export interface PortableRows {
	principals: { id: string; name: string };
	workspaces: { id: string; name: string; ownerId: string; kind: string };
	memberships: {
		id: string;
		userId: string;
		workspaceId: string;
		role: string;
	};
	folders: { id: string; workspaceId: string; name: string; sortKey: string };
	lists: {
		id: string;
		workspaceId: string;
		ownerId: string;
		title: string;
		kind: string;
		icon: string | null;
		folderId: string | null;
		sortKey: string;
		completedDisplay: string;
	};
	tasks: {
		id: string;
		listId: string;
		title: string;
		done: boolean;
		notes: string | null;
		dueAt: string | null;
		dueAllDay: boolean;
		priority: number;
		completedAt: string | null;
		sortKey: string;
		parentId: string | null;
		quantity: string | null;
		unit: string | null;
		category: string | null;
		rrule: string | null;
		recurrenceRelative: boolean;
		reminderTime: string | null;
		repeatEveryMin: number | null;
		maxRepeats: number | null;
		fallbackUserId: string | null;
		urgent: boolean;
	};
	labels: { id: string; workspaceId: string; name: string; color: string };
	taskLabels: { id: string; taskId: string; labelId: string };
	templates: {
		id: string;
		workspaceId: string;
		kind: string;
		name: string;
		icon: string | null;
		content: PortableJson;
		createdBy: string;
	};
	assignments: { id: string; taskId: string; userId: string };
	comments: {
		id: string;
		taskId: string;
		authorId: string;
		body: string;
		createdAt: string;
		editedAt: string | null;
	};
	habitLogs: {
		id: string;
		habitId: string;
		date: string;
		status: string;
		karmaDelta: number;
		completedAt: string | null;
		createdAt: string;
	};
	views: {
		id: string;
		ownerId: string;
		workspaceId: string | null;
		name: string;
		icon: string | null;
		scope: string;
		filter: PortableJson;
		display: PortableJson;
		sortKey: string;
		createdAt: string;
		updatedAt: string;
	};
	dashboards: {
		id: string;
		ownerId: string;
		workspaceId: string | null;
		scope: string;
		name: string;
		icon: string | null;
		panels: PortableJson;
		sortKey: string;
		createdAt: string;
		updatedAt: string;
	};
	userPrefs: {
		id: string;
		keymap: PortableJson;
		keymapProfile: string;
		homeViewRef: string | null;
		pinnedViews: PortableJson;
		karmaGoals: PortableJson;
		vacation: PortableJson;
		focus: PortableJson;
		timezone: string;
		quietHours: PortableJson;
		escalationDefaults: PortableJson;
		locale: string | null;
		theme: string | null;
		e2eAutoLockMinutes: number | null;
		createdAt: string;
		updatedAt: string;
	};
	focusSessions: {
		id: string;
		userId: string;
		taskId: string | null;
		kind: string;
		startedAt: string;
		endedAt: string;
		durationSec: number;
		createdAt: string;
	};
	karma: { userId: string; points: number; level: number; updatedAt: string };
	karmaEvents: {
		id: string;
		userId: string;
		date: string;
		delta: number;
		reason: string;
		createdAt: string;
	};
	attachments: {
		id: string;
		workspaceId: string;
		parentKind: string;
		parentId: string;
		keyVersion: number;
		declaredBytes: number;
		observedBytes: number | null;
		ciphertextSha256: string | null;
		thumbnailDeclaredBytes: number | null;
		thumbnailObservedBytes: number | null;
		thumbnailCiphertextSha256: string | null;
		uploadedBy: string;
		createdAt: string;
		committedAt: string | null;
	};
}

export interface PortableExportV1 {
	format: "ditero";
	schemaVersion: 1;
	exportedAt: string;
	sourceUserId: string;
	boundaries: {
		attachmentContent: "excluded";
		encryptionKeys: "excluded";
		credentials: "excluded";
		managedAccounts: "excluded";
		restoreSupported: false;
		taskHistory: "current-state-and-habit-logs";
	};
	data: { [K in keyof PortableRows]: PortableRows[K][] };
}
