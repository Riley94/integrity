/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';

/**
 * Placeholder Integrity account command. Copilot GitHub OAuth is not used;
 * Integrity accounts are not wired up yet, so this currently explains the
 * local-first fallback.
 */
export const INTEGRITY_SIGN_IN_COMMAND_ID = 'workbench.action.integrity.signIn';

export const integritySignInActionTitle = localize2('integrity.signIn', "Sign in to Integrity");
export const integritySignInActionTitleEllipsis = localize2('integrity.signInEllipsis', "Sign in to Integrity...");

export const integritySignInComingSoonTitle = localize('integrity.signInComingSoon.title', "Integrity accounts are coming soon");
export const integritySignInComingSoonDetail = localize('integrity.signInComingSoon.detail', "Until then, Integrity AI runs locally with Ollama or your own API keys.");
export const integritySignInComingSoonDismiss = localize('integrity.signInComingSoon.dismiss', "Continue without an account");

export async function showIntegritySignInComingSoon(dialogService: IDialogService): Promise<void> {
	await dialogService.info(integritySignInComingSoonTitle, integritySignInComingSoonDetail);
}
