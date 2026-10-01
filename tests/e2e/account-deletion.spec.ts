import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { m } from "../../src/paraglide/messages.js";
import {
	goToSettings,
	signUp,
	uniqueEmail,
	waitWorkspaceReady,
} from "./helpers.ts";

test("account deletion clears the session and releases the email address", async ({
	page,
}) => {
	const email = uniqueEmail("account-delete");
	await signUp(page, email);
	await waitWorkspaceReady(page);
	await goToSettings(page);

	await page.getByTestId("delete-account-open").click();
	const dialog = page.getByTestId("delete-account-dialog");
	await expect(dialog).toBeVisible();
	await expect(page.getByTestId("delete-account-confirm")).toBeEnabled();
	const { violations } = await new AxeBuilder({ page }).analyze();
	expect(
		violations.filter(
			({ impact }) => impact === "serious" || impact === "critical",
		),
	).toEqual([]);

	await page.getByTestId("delete-account-confirm").click();
	await expect(page.getByTestId("signup-mode")).toBeVisible();

	await signUp(page, email);
	await expect(page.getByTestId("workspace")).toBeVisible();
});

test("account deletion requires the last-key-holder acknowledgement", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("account-delete-warning"));
	await waitWorkspaceReady(page);
	await goToSettings(page);
	await page.route("**/api/account/deletion-preview", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				lastHolderWorkspaces: [{ id: "shared", name: "Family" }],
				soleOwnerWorkspaces: [],
			}),
		}),
	);

	await page.getByTestId("delete-account-open").click();
	await expect(page.getByText(m.e2e_last_holder_title())).toBeVisible();
	const confirm = page.getByTestId("delete-account-confirm");
	await expect(confirm).toBeDisabled();
	// The app's own square checkbox, named by its visible label; clicking the
	// label text toggles it like a native one would.
	const ack = page.getByRole("checkbox", { name: m.e2e_last_holder_ack() });
	await expect(ack).toHaveAttribute("data-slot", "checkbox");
	await expect(ack).toHaveAttribute("data-shape", "square");
	await page.getByText(m.e2e_last_holder_ack(), { exact: true }).click();
	await expect(ack).toBeChecked();
	await expect(confirm).toBeEnabled();

	const { violations } = await new AxeBuilder({ page }).analyze();
	expect(
		violations.filter(
			({ impact }) => impact === "serious" || impact === "critical",
		),
	).toEqual([]);
});
