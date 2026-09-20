The **residual connection** lets the gradient skip the block: the output is $y = x + F(x)$, so $\partial y / \partial x = I + \partial F / \partial x$ never vanishes.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 200">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="ink"/>
    </marker>
  </defs>
  <text x="180" y="22" text-anchor="middle" font-size="13" font-weight="bold" fill="ink">Residual block</text>
  <circle cx="40" cy="110" r="18" fill="surface" stroke="ink" stroke-width="1.5"/>
  <text x="40" y="114" text-anchor="middle" font-size="12" fill="ink">x</text>
  <rect x="110" y="86" width="110" height="48" rx="8" fill="accent-soft" stroke="accent" stroke-width="1.5"/>
  <text x="165" y="114" text-anchor="middle" font-size="12" fill="ink">F(x) · 2 layers</text>
  <circle cx="270" cy="110" r="14" fill="violet-soft" stroke="violet" stroke-width="1.5"/>
  <text x="270" y="115" text-anchor="middle" font-size="14" fill="ink">+</text>
  <circle cx="330" cy="110" r="18" fill="surface" stroke="ink" stroke-width="1.5"/>
  <text x="330" y="114" text-anchor="middle" font-size="12" fill="ink">y</text>
  <line x1="58" y1="110" x2="108" y2="110" stroke="ink" stroke-width="1.5" marker-end="url(#arrow)"/>
  <line x1="220" y1="110" x2="254" y2="110" stroke="ink" stroke-width="1.5" marker-end="url(#arrow)"/>
  <line x1="284" y1="110" x2="310" y2="110" stroke="ink" stroke-width="1.5" marker-end="url(#arrow)"/>
  <path d="M 40 92 C 40 50, 270 50, 270 94" fill="none" stroke="teal" stroke-width="1.5" stroke-dasharray="4 4" stroke-linecap="round" marker-end="url(#arrow)"/>
  <text x="155" y="54" text-anchor="middle" font-size="11" fill="teal">identity shortcut</text>
  <line x1="20" y1="170" x2="340" y2="170" stroke="line" stroke-width="1"/>
  <text x="180" y="188" text-anchor="middle" font-size="11" fill="muted">gradient flows through both paths</text>
</svg>
```

Without the shortcut, deep stacks multiply many small Jacobians and the signal fades.
