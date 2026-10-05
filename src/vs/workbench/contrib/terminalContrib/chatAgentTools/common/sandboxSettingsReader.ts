/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { AgentNetworkDomainSettingId } from '../../../../../platform/networkFilter/common/settings.js';
import { AgentSandboxSettingId } from '../../../../../platform/sandbox/common/settings.js';

/** Setting IDs that affect the engine's sandbox configuration. */
export const SANDBOX_SETTING_KEYS: readonly string[] = [
	AgentSandboxSettingId.AgentSandboxEnabled,
	AgentSandboxSettingId.AgentSandboxWindowsEnabled,
	AgentSandboxSettingId.AgentSandboxAllowNetwork,
	AgentSandboxSettingId.AgentSandboxAllowUnsandboxedCommands,
	AgentSandboxSettingId.AgentSandboxLinuxFileSystem,
	AgentSandboxSettingId.AgentSandboxMacFileSystem,
	AgentSandboxSettingId.AgentSandboxWindowsFileSystem,
	AgentSandboxSettingId.AgentSandboxWindowsSchemaVersion,
	AgentSandboxSettingId.AgentSandboxAdvancedRuntime,
	AgentNetworkDomainSettingId.AllowedNetworkDomains,
	AgentNetworkDomainSettingId.DeniedNetworkDomains,
];

/**
 * Reads a single sandbox-related setting from `IConfigurationService`.
 * Legacy boolean sandbox enabled values are normalized to `'on' | 'off'`.
 */
export function readSandboxSetting<T>(configurationService: IConfigurationService, _logService: ILogService, settingId: string): T | undefined {
	return normalizeSandboxSettingValue<T>(settingId, configurationService.inspect<T>(settingId).value);
}

/**
 * Coerce legacy boolean sandbox enabled settings to `'on' | 'off'`.
 */
function normalizeSandboxSettingValue<T>(settingId: string, value: T | undefined): T | undefined {
	if (settingId === AgentSandboxSettingId.AgentSandboxEnabled || settingId === AgentSandboxSettingId.AgentSandboxWindowsEnabled) {
		if (value === true) {
			return 'on' as unknown as T;
		}
		if (value === false) {
			return 'off' as unknown as T;
		}
	}
	return value;
}
