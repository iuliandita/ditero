import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
// samlify is the package @better-auth/sso verifies with; the fixture reuses it
// so a forged response differs from a real one only in the property under test.
import * as samlify from "samlify";

export type FixtureResponse = {
	// Defaults to the SP entity ID of the request.
	audience?: string;
	destination?: string | null;
	recipient?: string | null;
	nameId?: string;
	nameIdFormat?: string;
	email?: string | null;
	name?: string;
	signAssertion?: boolean;
	// Milliseconds relative to now.
	notBeforeOffset?: number;
	notOnOrAfterOffset?: number;
	omitConditionTimes?: boolean;
	omitInResponseTo?: boolean;
	inResponseTo?: string;
	issuer?: string;
	assertionId?: string;
	statusSuccess?: boolean;
};

export type FixtureIdp = {
	entityId: string;
	metadataXml: string;
	certificatePem: string;
	keyPem: string;
	// Reads the AuthnRequest out of the redirect Ditero issued.
	parseRedirect(location: string): {
		requestId: string;
		relayState: string | null;
		acs: string;
		spEntityId: string;
	};
	respond(
		request: { requestId: string; acs: string; spEntityId: string },
		overrides?: FixtureResponse,
	): Promise<string>;
};

const NS_SAML = "urn:oasis:names:tc:SAML:2.0:assertion";
const NS_SAMLP = "urn:oasis:names:tc:SAML:2.0:protocol";

function escapeXml(value: string): string {
	return value.replace(
		/[<>&"']/g,
		(character) => `&#${character.charCodeAt(0)};`,
	);
}

function selfSignedCertificate(dir: string, commonName: string) {
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-sha256",
			"-days",
			"30",
			"-subj",
			`/CN=${commonName}`,
			"-keyout",
			join(dir, "key.pem"),
			"-out",
			join(dir, "cert.pem"),
		],
		{ stdio: "ignore" },
	);
	return {
		keyPem: readFileSync(join(dir, "key.pem"), "utf8"),
		certificatePem: readFileSync(join(dir, "cert.pem"), "utf8"),
	};
}

export function generateKeyPair(commonName = "ditero-test") {
	const dir = mkdtempSync(join(tmpdir(), "ditero-saml-key-"));
	try {
		return selfSignedCertificate(dir, commonName);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const stripPem = (pem: string) => pem.replace(/-----[A-Z ]+-----|\s/g, "");

export function createFixtureIdp(
	entityId: string,
	options: { wantRequestsSigned?: boolean; extraCertificates?: string[] } = {},
): FixtureIdp {
	const { keyPem, certificatePem } = generateKeyPair("ditero-test-idp");
	const ssoURL = `${entityId}/sso`;
	const descriptor = (certificates: string[]) =>
		`<?xml version="1.0"?><EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${escapeXml(entityId)}"><IDPSSODescriptor WantAuthnRequestsSigned="${options.wantRequestsSigned === true}" protocolSupportEnumeration="${NS_SAMLP}">${certificates
			.map(
				(pem) =>
					`<KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${stripPem(pem)}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>`,
			)
			.join(
				"",
			)}<NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</NameIDFormat><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${escapeXml(ssoURL)}"/></IDPSSODescriptor></EntityDescriptor>`;
	// The published document may list retired certificates; the signer holds one.
	const metadataXml = descriptor([
		certificatePem,
		...(options.extraCertificates ?? []),
	]);

	const idp = samlify.IdentityProvider({
		metadata: descriptor([certificatePem]),
		privateKey: keyPem,
		isAssertionEncrypted: false,
		nameIDFormat: ["urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"],
	});

	return {
		entityId,
		metadataXml,
		certificatePem,
		keyPem,
		parseRedirect(location) {
			const url = new URL(location);
			const encoded = url.searchParams.get("SAMLRequest");
			if (!encoded) throw new Error("redirect carries no SAMLRequest");
			const xml = inflateRawSync(Buffer.from(encoded, "base64")).toString(
				"utf8",
			);
			const requestId = /\bID="([^"]+)"/.exec(xml)?.[1];
			const acs = /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)?.[1];
			const spEntityId = /<(?:\w+:)?Issuer[^>]*>([^<]+)</.exec(xml)?.[1];
			if (!requestId || !acs || !spEntityId)
				throw new Error("AuthnRequest is missing ID, ACS or Issuer");
			return {
				requestId,
				relayState: url.searchParams.get("RelayState"),
				acs,
				spEntityId,
			};
		},
		async respond(request, overrides = {}) {
			const now = Date.now();
			const iso = (offset: number) => new Date(now + offset).toISOString();
			const notOnOrAfter = iso(overrides.notOnOrAfterOffset ?? 5 * 60_000);
			const notBefore = iso(overrides.notBeforeOffset ?? -60_000);
			const audience = overrides.audience ?? request.spEntityId;
			const destination =
				overrides.destination === undefined
					? request.acs
					: overrides.destination;
			const recipient =
				overrides.recipient === undefined ? request.acs : overrides.recipient;
			const nameId = overrides.nameId ?? "fixture-name-id";
			const email =
				overrides.email === undefined ? "alice@example.test" : overrides.email;
			const inResponseTo = overrides.omitInResponseTo
				? ""
				: (overrides.inResponseTo ?? request.requestId);
			const inResponseAttr = inResponseTo
				? ` InResponseTo="${escapeXml(inResponseTo)}"`
				: "";
			const issuer = overrides.issuer ?? entityId;
			const assertionId =
				overrides.assertionId ?? `_a${randomBytes(12).toString("hex")}`;
			const attributes = [
				email === null ? "" : attribute("email", email),
				attribute("displayName", overrides.name ?? "Alice Example"),
			].join("");
			const sign = overrides.signAssertion ?? true;
			const responseXml = `<samlp:Response xmlns:samlp="${NS_SAMLP}" xmlns:saml="${NS_SAML}" ID="_r${randomBytes(12).toString("hex")}" Version="2.0" IssueInstant="${iso(0)}"${destination === null ? "" : ` Destination="${escapeXml(destination)}"`}${inResponseAttr}><saml:Issuer>${escapeXml(issuer)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:${overrides.statusSuccess === false ? "Responder" : "Success"}"/></samlp:Status><saml:Assertion xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema" ID="${assertionId}" Version="2.0" IssueInstant="${iso(0)}"><saml:Issuer>${escapeXml(issuer)}</saml:Issuer><saml:Subject><saml:NameID Format="${overrides.nameIdFormat ?? "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"}">${escapeXml(nameId)}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}"${recipient === null ? "" : ` Recipient="${escapeXml(recipient)}"`}${inResponseAttr}/></saml:SubjectConfirmation></saml:Subject><saml:Conditions${overrides.omitConditionTimes ? "" : ` NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"`}><saml:AudienceRestriction><saml:Audience>${escapeXml(audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_s${randomBytes(6).toString("hex")}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement>${attributes}</saml:AttributeStatement></saml:Assertion></samlp:Response>`;
			const sp = samlify.ServiceProvider({
				entityID: request.spEntityId,
				wantAssertionsSigned: sign,
				assertionConsumerService: [
					{
						Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
						Location: request.acs,
					},
				],
			});
			const result = await idp.createLoginResponse(
				sp,
				{ extract: { request: { id: request.requestId } } } as never,
				"post",
				{ email: nameId },
				() => ({ id: assertionId, context: responseXml }),
			);
			return result.context as string;
		},
	};
}

function attribute(name: string, value: string): string {
	return `<saml:Attribute Name="${escapeXml(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic"><saml:AttributeValue xsi:type="xs:string">${escapeXml(value)}</saml:AttributeValue></saml:Attribute>`;
}
