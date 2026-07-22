/* @jsxImportSource @opentui/react */
import type { ReactNode } from "react";

import { useTheme } from "@/components/ui/theme-provider";
import type { BorderStyle } from "@/components/ui/types";

export interface CardProps {
  /** Share the row evenly with sibling cards (helipod addition — the upstream
   *  component declares `width` but never applies it, so cards sized to their
   *  content and left a ragged gap). */
  grow?: boolean;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  borderColor?: string;
  width?: number;
  borderStyle?: BorderStyle;
  paddingX?: number;
  paddingY?: number;
  footerDividerChar?: string;
}

export const Card = ({
  title,
  subtitle,
  children,
  footer,
  borderColor,
  width,
  borderStyle = "rounded",
  paddingX = 1,
  paddingY = 0,
  footerDividerChar = "─",
  grow,
}: CardProps) => {
  const theme = useTheme();
  const resolvedBorderColor = borderColor ?? theme.colors.border;

  return (
    <box
      flexDirection="column"
      borderColor={resolvedBorderColor}
      width={width}
      flexGrow={grow ? 1 : undefined}
      flexBasis={grow ? 0 : undefined}
      paddingLeft={paddingX}
      paddingRight={paddingX}
      paddingTop={paddingY}
      paddingBottom={paddingY}
    >
      {(title || subtitle) && (
        <box flexDirection="column" paddingBottom={1}>
          {title && (
            <text fg={theme.colors.foreground}>
              <b>{title}</b>
            </text>
          )}
          {subtitle && (
            <text fg={theme.colors.mutedForeground}>{subtitle}</text>
          )}
        </box>
      )}
      <box flexDirection="column">{children}</box>
      {footer && (
        <box flexDirection="column" marginTop={1} paddingTop={1}>
          <text fg={resolvedBorderColor}>{footerDividerChar.repeat(30)}</text>
          <box marginTop={0}>{footer}</box>
        </box>
      )}
    </box>
  );
};
