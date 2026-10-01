/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Riley94. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Apply a workspace edit, then write that file to disk.
 * `applyEdit` updates the open editor and leaves it dirty, so a later read from
 * disk would still see the previous contents until something saves.
 * The save runs only after the edit is accepted. A rejected edit is left untouched.
 */
export async function applyEditThenSave(
	apply: () => PromiseLike<boolean>,
	save: () => PromiseLike<boolean>,
): Promise<boolean> {
	if (!await apply()) {
		return false;
	}
	return save();
}
