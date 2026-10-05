/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IObservable } from '../../../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IHoverService } from '../../../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { MockContextKeyService } from '../../../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { InMemoryStorageService } from '../../../../../../../platform/storage/common/storage.js';
import { ChatContextUsageWidget, CircularProgressIndicator, isSameContextUsageData, resolveContextWindowInputTokens } from '../../../../browser/widgetHosts/viewPane/chatContextUsageWidget.js';
import { ChatContextUsageDetails, IChatContextUsageData } from '../../../../browser/widgetHosts/viewPane/chatContextUsageDetails.js';
import { IChatUsage } from '../../../../common/chatService/chatService.js';
import { ILanguageModelChatMetadata, ILanguageModelConfigurationSchema, ILanguageModelsService } from '../../../../common/languageModels.js';
import { IChatRequestModel, IChatResponseModel } from '../../../../common/model/chatModel.js';

const FULL_WINDOW = 1_000_000;
const DEFAULT_TIER = 200_000;

const schemaWithContextSize: ILanguageModelConfigurationSchema = {
	properties: {
		thinkingEffort: { enum: ['low', 'medium', 'high'], default: 'medium' },
		contextSize: { type: 'number', default: DEFAULT_TIER },
	}
};

// A model that exposes no context-size picker (e.g. no tiered pricing).
const schemaWithoutContextSize: ILanguageModelConfigurationSchema = {
	properties: {
		thinkingEffort: { enum: ['low', 'medium', 'high'], default: 'medium' },
	}
};

suite('resolveContextWindowInputTokens', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses an explicit configured contextSize over everything else', () => {
		assert.strictEqual(
			resolveContextWindowInputTokens({ contextSize: 500_000 }, schemaWithContextSize, FULL_WINDOW),
			500_000,
		);
	});

	test('falls back to the schema default tier when contextSize is absent (regression for #320393)', () => {
		// The exact bug: a resolved configuration missing `contextSize` must NOT
		// make the gauge jump to the model's full native window. It must match the
		// default tier the request uses.
		assert.strictEqual(
			resolveContextWindowInputTokens({ thinkingEffort: 'high' }, schemaWithContextSize, FULL_WINDOW),
			DEFAULT_TIER,
		);
		assert.strictEqual(
			resolveContextWindowInputTokens(undefined, schemaWithContextSize, FULL_WINDOW),
			DEFAULT_TIER,
		);
	});

	test('ignores a non-numeric configured contextSize and uses the schema default', () => {
		assert.strictEqual(
			resolveContextWindowInputTokens({ contextSize: 'big' }, schemaWithContextSize, FULL_WINDOW),
			DEFAULT_TIER,
		);
	});

	test('falls through to the full window when the schema has no contextSize default', () => {
		// Models without a context-size picker have no schema default, so default
		// and max are the same value and the full window is correct.
		assert.strictEqual(
			resolveContextWindowInputTokens({ thinkingEffort: 'high' }, schemaWithoutContextSize, FULL_WINDOW),
			FULL_WINDOW,
		);
		assert.strictEqual(
			resolveContextWindowInputTokens(undefined, undefined, FULL_WINDOW),
			FULL_WINDOW,
		);
	});

	test('returns undefined when neither a configured value, schema default, nor max window is available', () => {
		assert.strictEqual(resolveContextWindowInputTokens(undefined, undefined, undefined), undefined);
	});
});

suite('isSameContextUsageData', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const base: IChatContextUsageData = {
		usedTokens: 50_000,
		completionTokens: 4_000,
		totalContextWindow: 100_000,
		percentage: 50,
		outputBufferPercentage: 8,
		sessionCost: 2,
		promptTokenDetails: [{ category: 'files', label: 'a', percentageOfPrompt: 40 }],
	};

	test('treats fresh objects with identical fields as equal (avoids redundant popover repaints)', () => {
		assert.strictEqual(isSameContextUsageData(base, { ...base, promptTokenDetails: [{ ...base.promptTokenDetails![0] }] }), true);
	});

	test('detects changes in any displayed field, including the token-details breakdown', () => {
		assert.strictEqual(isSameContextUsageData(base, { ...base, percentage: 15 }), false);
		assert.strictEqual(isSameContextUsageData(base, { ...base, sessionCost: 3 }), false);
		assert.strictEqual(isSameContextUsageData(base, { ...base, promptTokenDetails: [{ category: 'files', label: 'a', percentageOfPrompt: 41 }] }), false);
	});

	test('handles undefined on either side', () => {
		assert.strictEqual(isSameContextUsageData(undefined, undefined), true);
		assert.strictEqual(isSameContextUsageData(base, undefined), false);
		assert.strictEqual(isSameContextUsageData(undefined, base), false);
	});
});

suite('CircularProgressIndicator', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('draws a 15px radial ring with a 2px stroke that fills clockwise from empty', () => {
		const indicator = new CircularProgressIndicator();
		const arc = indicator.domNode.querySelector('.progress-arc');
		const track = indicator.domNode.querySelector('.progress-bg');
		assert.ok(arc instanceof SVGCircleElement);
		assert.ok(track instanceof SVGCircleElement);

		// 15px box, 2px stroke, inset 1px so round caps stay inside the viewBox.
		const radius = 5.5;
		const circumference = 2 * Math.PI * radius;
		assert.strictEqual(indicator.domNode.getAttribute('viewBox'), '0 0 15 15');
		assert.strictEqual(arc.getAttribute('r'), String(radius));
		assert.strictEqual(track.getAttribute('r'), String(radius));
		assert.strictEqual(arc.getAttribute('stroke-width'), '2');
		assert.strictEqual(arc.getAttribute('stroke-linecap'), 'round');
		assert.ok(Math.abs(parseFloat(arc.getAttribute('stroke-dasharray') ?? '') - circumference) < 1e-6);

		const offsetAt = (percentage: number) => {
			indicator.setProgress(percentage);
			return parseFloat(arc.getAttribute('stroke-dashoffset') ?? '');
		};
		assert.ok(Math.abs(offsetAt(0) - circumference) < 1e-6);
		assert.ok(Math.abs(offsetAt(50) - circumference / 2) < 1e-6);
		assert.ok(Math.abs(offsetAt(100) - 0) < 1e-6);
		// Values outside 0-100 clamp so the ring cannot over- or under-draw.
		assert.ok(Math.abs(offsetAt(150) - 0) < 1e-6);
		assert.ok(Math.abs(offsetAt(-10) - circumference) < 1e-6);
	});
});

suite('ChatContextUsageWidget', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const AUTO_MODEL = 'vendor:auto';
	const CONCRETE_MODEL = 'vendor:gpt';

	// Mirrors the Agent Host scenario where the synthetic "auto" model advertises
	// a zero-sized context window (it routes to a concrete model) while the
	// concrete model exposes a real window. See issue #321781.
	const models: Record<string, Partial<ILanguageModelChatMetadata>> = {
		[AUTO_MODEL]: { maxInputTokens: 0, maxOutputTokens: 0 },
		[CONCRETE_MODEL]: { maxInputTokens: 100_000, maxOutputTokens: 8_000 },
	};

	function createLanguageModelsService(): ILanguageModelsService {
		return {
			onDidChangeLanguageModels: Event.None,
			lookupLanguageModel: (id: string) => models[id] as ILanguageModelChatMetadata | undefined,
			getModelConfiguration: (_id: string) => undefined,
		} as unknown as ILanguageModelsService;
	}

	function createWidget(instantiationService: IInstantiationService = {} as IInstantiationService): ChatContextUsageWidget {
		const hoverService = {
			setupDelayedHover: () => Disposable.None,
			showInstantHover: () => { },
		} as unknown as IHoverService;
		return store.add(new ChatContextUsageWidget(
			hoverService,
			instantiationService,
			createLanguageModelsService(),
			new MockContextKeyService(),
			store.add(new InMemoryStorageService()),
			new TestConfigurationService(),
		));
	}

	function createWidgetWithData(): { widget: ChatContextUsageWidget; getData: () => IChatContextUsageData | undefined } {
		let currentData: IObservable<IChatContextUsageData | undefined> | undefined;
		const details = {
			domNode: document.createElement('div'),
			setChatWidget: () => { },
			dispose: () => { },
		} as unknown as ChatContextUsageDetails;
		const widget = createWidget({
			createInstance: (_ctor: unknown, _chatWidget: unknown, data: IObservable<IChatContextUsageData | undefined>) => {
				currentData = data;
				return details;
			},
		} as unknown as IInstantiationService);
		return { widget, getData: () => currentData?.get() };
	}

	function createRequest(modelId: string, usage: IChatUsage | undefined, onDidChange: Event<void> = Event.None, sessionCost: () => number = () => 0): IChatRequestModel {
		const session = { get sessionCost() { return sessionCost(); } } as IChatRequestModel['session'];
		const response = { usage, onDidChange, session } as unknown as IChatResponseModel;
		return { modelId, response, session } as unknown as IChatRequestModel;
	}

	function usage(actualModelId?: string): IChatUsage {
		return { kind: 'usage', promptTokens: 50_000, completionTokens: 4_000, actualModelId };
	}

	test('shows a 0% ring as soon as a model with a context window is selected', () => {
		const widget = createWidget();
		widget.setSelectedModel(CONCRETE_MODEL);

		assert.strictEqual(widget.isVisible.get(), true);
		assert.strictEqual(widget.domNode.querySelector('.percentage-label')?.textContent, '0%');
		assert.strictEqual(widget.domNode.style.display, '');
	});

	test('keeps the empty ring when a new chat clears the last request', () => {
		const widget = createWidget();
		widget.setSelectedModel(CONCRETE_MODEL);
		widget.update(createRequest(CONCRETE_MODEL, usage(undefined)));
		assert.strictEqual(widget.domNode.querySelector('.percentage-label')?.textContent, '50%');

		widget.update(undefined);

		assert.strictEqual(widget.isVisible.get(), true);
		assert.strictEqual(widget.domNode.querySelector('.percentage-label')?.textContent, '0%');
	});

	test('falls back to the actual model window when "auto" is selected (regression for #321781)', () => {
		const widget = createWidget();
		// User has "auto" selected; "auto" has no window of its own but the
		// response reports the concrete model that actually served the request.
		widget.setSelectedModel(AUTO_MODEL);
		widget.update(createRequest(AUTO_MODEL, usage(CONCRETE_MODEL)));

		assert.strictEqual(widget.isVisible.get(), true);
		// 54,000 used / (100,000 + 8,000) window === 50%, proving the concrete
		// model's window was used as the denominator rather than "auto"'s zero.
		assert.strictEqual(widget.domNode.querySelector('.percentage-label')?.textContent, '50%');
	});

	test('stays hidden for "auto" when there is no actual model to fall back to', () => {
		const widget = createWidget();
		widget.setSelectedModel(AUTO_MODEL);
		widget.update(createRequest(AUTO_MODEL, usage(undefined)));

		assert.strictEqual(widget.isVisible.get(), false);
	});

	test('uses the selected concrete model window directly', () => {
		const widget = createWidget();
		widget.setSelectedModel(CONCRETE_MODEL);
		widget.update(createRequest(CONCRETE_MODEL, usage(undefined)));

		assert.strictEqual(widget.isVisible.get(), true);
		assert.strictEqual(widget.domNode.querySelector('.percentage-label')?.textContent, '50%');
	});

	test('keeps the percentage beside the radial ring', () => {
		const widget = createWidget();
		widget.setSelectedModel(CONCRETE_MODEL);
		widget.update(createRequest(CONCRETE_MODEL, usage(undefined)));

		const label = widget.domNode.querySelector('.percentage-label');
		const ring = widget.domNode.querySelector('.circular-progress');
		assert.ok(label);
		assert.ok(ring);
		// The number leads the ring, and the ring is the thin radial meter.
		assert.strictEqual(label.compareDocumentPosition(ring) & Node.DOCUMENT_POSITION_FOLLOWING, Node.DOCUMENT_POSITION_FOLLOWING);
		assert.strictEqual(ring.getAttribute('viewBox'), '0 0 15 15');
		assert.strictEqual(ring.querySelector('.progress-arc')?.getAttribute('stroke-width'), '2');
	});

	test('colors the ring as a warning at 75% and an error at 90%', () => {
		const widget = createWidget();
		widget.setSelectedModel(CONCRETE_MODEL);

		widget.update(createRequest(CONCRETE_MODEL, { kind: 'usage', promptTokens: 81_000, completionTokens: 0 }));
		assert.strictEqual(widget.domNode.classList.contains('warning'), true);
		assert.strictEqual(widget.domNode.classList.contains('error'), false);

		widget.update(createRequest(CONCRETE_MODEL, { kind: 'usage', promptTokens: 97_200, completionTokens: 0 }));
		assert.strictEqual(widget.domNode.classList.contains('warning'), false);
		assert.strictEqual(widget.domNode.classList.contains('error'), true);
		assert.strictEqual(widget.domNode.querySelector('.percentage-label')?.textContent, '90%');
	});

	test('resolves session cost again when response data changes', () => {
		const responseChange = store.add(new Emitter<void>());
		const { widget, getData } = createWidgetWithData();
		let sessionCost = 2;

		widget.update(createRequest(CONCRETE_MODEL, usage(), responseChange.event, () => sessionCost));
		assert.strictEqual(widget.showDetails(), true);
		assert.strictEqual(getData()?.sessionCost, 2);

		sessionCost = 7;
		responseChange.fire();

		assert.strictEqual(getData()?.sessionCost, 7);
	});

	test('refreshes session cost without changing displayed token usage', () => {
		const { widget, getData } = createWidgetWithData();

		widget.update(createRequest(CONCRETE_MODEL, usage(), Event.None, () => 2));
		assert.strictEqual(widget.showDetails(), true);
		const before = getData();

		widget.updateSessionCost(7);

		assert.deepStrictEqual(getData(), { ...before, sessionCost: 7 });
	});

});
