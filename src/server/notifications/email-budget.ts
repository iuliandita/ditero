// Shared by verification and scheduled mail, across replicas and address changes.
export const EMAIL_SEND_CAPACITY = 20;
export const EMAIL_SEND_REFILL_PER_SEC = 1 / 60;

export function emailBudgetKey(userId: string): string {
	return `notification-email:${userId}`;
}
