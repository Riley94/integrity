/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { TextModelEditSource } from '../../../../../editor/common/textModelEditSource.js';
import { EditTelemetryTrigger } from '../../../../../platform/telemetry/common/editTelemetry.js';

export interface IAgentHostEditAttributionCoverageGap {
	readonly editCount: number;
	readonly insertedCount: number;
}

export interface IPreparedAgentHostEditAttributionFlush {
	readonly flushToken: string;
	readonly agentModifiedCount: number;
	readonly lastSequence?: number;
	readonly coverageGapThroughSequence?: number;
	readonly deferCoverageGap?: boolean;
	commit(totalModifiedCount: number): Promise<void>;
}

export class AgentHostEditAttributionUnknownOutcomeError extends Error {
	constructor(cause: unknown) {
		super('The Agent Host edit attribution outcome is unknown', { cause });
	}
}

export class AgentHostEditAttributionDeferredError extends Error {
	constructor(cause: unknown) {
		super('The Agent Host edit attribution was deferred', { cause });
	}
}

/**
 * Edit attribution used to be reported by the agent host. The host is gone,
 * so tracking runs without a marker service.
 */
export interface IAgentHostEditMarkerService {
	createCorrelation(resource: URI): IExternalEditCorrelation;
	takeCoverageGap?(resource: URI, throughSequence?: number): IAgentHostEditAttributionCoverageGap | undefined;
	prepareFlush(resource: URI, trigger: EditTelemetryTrigger, statsUuid: string, isDirty: boolean, languageId?: string): Promise<IPreparedAgentHostEditAttributionFlush | undefined>;
}

export interface IExternalEditCorrelation {
	readonly onDidSuppress: Event<string>;
	readonly onDidResolve?: Event<IExternalEditCorrelationResolution>;
	readonly onDidInvalidate: Event<string>;
	register(before: string, after: string): string;
	isSuppressed(id: string): boolean;
	getResolution?(id: string): IExternalEditCorrelationResolution | undefined;
	waitForResolution?(ids: readonly string[], timeoutMs: number): Promise<void>;
	release(id: string): void;
}

export interface IExternalEditCorrelationResolution {
	readonly id: string;
	readonly source?: TextModelEditSource;
}
