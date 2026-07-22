/* @jsxImportSource @opentui/react */
import type { ReactNode } from "react";

import { useTheme } from "@/components/ui/theme-provider";
import type { BorderStyle } from "@/components/ui/types";

export interface CardProps {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  borderColor?: string;
  width?: number;
  /** helipod addition: lets a card claim remaining vertical space. */
  height?: number;
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
  height,
  borderStyle = "rounded",
  paddingX = 1,
  paddingY = 0,
  footerDividerChar = "─",
}: CardProps) => {
  const theme = useTheme();
  const resolvedBorderColor = borderColor ?? theme.colors.border;

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      borderColor={resolvedBorderColor}
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
