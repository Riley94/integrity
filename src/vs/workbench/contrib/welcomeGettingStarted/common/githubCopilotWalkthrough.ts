/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const GITHUB_COPILOT_WALKTHROUGH_EXTENSION_IDS = new Set([
	'github.copilot',
	'github.copilot-chat',
]);

/**
 * GitHub Copilot's built-in walkthrough is leftover VS Code branding. Integrity
 * hides it from the Welcome page Walkthroughs list until Integrity-owned
 * onboarding replaces it.
 */
export function isGitHubCopilotWalkthroughExtension(extensionId: string): boolean {
	return GITHUB_COPILOT_WALKTHROUGH_EXTENSION_IDS.has(extensionId.toLowerCase());
}
