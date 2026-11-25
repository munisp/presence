/**
 * RN renderer (b47) — the thin native half of the UI layer.
 *
 * Everything testable lives in src/presence/ui/*.ts; this file only
 * walks a UiNode tree and maps it onto React Native components. It
 * holds no product logic: kind → component, tone → theme style, action
 * → pressable with the a11y contract fields. Like App.tsx it is
 * typechecked by tsconfig.json and deliberately outside the pinned
 * tsconfig.build.json include — the RN surface is never executed under
 * node.
 */

import React from "react";
import { Pressable, Text, View } from "react-native";

import { resolveCopy, type LocaleBundle } from "../presence/copyRegistry.js";
import { textStyle, ACTION_TARGET_PT, type ThemeTone } from "../presence/ui/theme.js";
import type { UiNode } from "../presence/ui/screens.js";

/** The display receives the active locale; null is the English floor. */
export interface RenderContext {
  locale: LocaleBundle | null;
  /** Dynamic-type preference, passed through the NFR-25 clamp. */
  preferredScale: number;
  /** Action dispatch — the shell wires affordances to behaviour. */
  onAction: (affordance: string, nodeId: string) => void;
}

function renderText(node: UiNode, ctx: RenderContext, key: string): React.ReactElement | null {
  const tone: ThemeTone = node.tone ?? "note";
  const style = textStyle(tone, ctx.preferredScale);
  if (style === null) return null;
  // The descriptor carries the English baseline; re-resolve the key so a
  // locale pack overrides without touching the descriptor.
  const text =
    node.copyKey !== undefined
      ? resolveCopy(ctx.locale, node.copyKey) ?? node.text ?? ""
      : node.text ?? "";
  return (
    <Text
      key={key}
      testID={node.id}
      style={{
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontSize: style.fontSizePt,
        fontWeight: style.bold ? "700" : "400",
      }}
    >
      {text}
    </Text>
  );
}

function renderAction(node: UiNode, ctx: RenderContext, key: string): React.ReactElement | null {
  const label =
    node.copyKey !== undefined
      ? resolveCopy(ctx.locale, node.copyKey) ?? node.label ?? ""
      : node.label ?? "";
  if (label.trim().length === 0) return null;
  const affordance = node.affordance ?? node.id;
  return (
    <Pressable
      key={key}
      testID={node.id}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => ctx.onAction(affordance, node.id)}
      style={{
        minWidth: ACTION_TARGET_PT.width,
        minHeight: ACTION_TARGET_PT.height,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 12,
      }}
    >
      <Text style={{ fontSize: 16 }}>{label}</Text>
    </Pressable>
  );
}

/** Walk one node. Unknown kinds render nothing — never improvise. */
export function renderNode(
  node: UiNode,
  ctx: RenderContext,
  key = node.id,
): React.ReactElement | null {
  if (node.kind === "text") return renderText(node, ctx, key);
  if (node.kind === "action") return renderAction(node, ctx, key);
  if (node.kind === "region" || node.kind === "screen") {
    return (
      <View key={key} testID={node.id}>
        {(node.children ?? []).map((child, index) => renderNode(child, ctx, `${key}/${index}`))}
      </View>
    );
  }
  return null;
}
