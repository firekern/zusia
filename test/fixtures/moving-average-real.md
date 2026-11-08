In Example 2.3 (p. 41), the moving-average system is introduced as an elementary yet fundamental discrete-time system that forms the local arithmetic mean of an input sequence over a sliding window.

\begin{definition}[Moving-Average System]\label{def:moving-average}
Let $x[n]$ denote the input sequence. For non-negative integers $M_1$ and $M_2$, the general **moving-average (MA) system** is defined by the input–output transformation:
\begin{equation}
y[n] = \frac{1}{M_1 + M_2 + 1} \sum_{k=-M_1}^{M_2} x[n - k] \label{eq:ma_def}
\end{equation}
Expanding the summation explicitly:
\begin{equation}
y[n] = \frac{1}{M_1 + M_2 + 1} \Big( x[n + M_1] + \dots + x[n] + \dots + x[n - M_2] \Big) \label{eq:ma_expanded}
\end{equation}
\end{definition}

### Intuition and Window Geometry

At time index $n$, the system averages $M_1 + M_2 + 1$ consecutive samples centered or offset around $n$:
* $M_1$ denotes the number of **future** samples involved ($x[n+1], \dots, x[n+M_1]$).
* $M_2$ denotes the number of **past** samples involved ($x[n-1], \dots, x[n-M_2]$).
* When advancing from time $n$ to $n+1$, the observation window shifts rigidly one sample to the right along the sequence axis (p. 41).

```svg
<svg viewBox="0 0 360 130" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="ink"/>
    </marker>
  </defs>

  <!-- Horizontal Axis -->
  <line x1="20" y1="90" x2="340" y2="90" stroke="muted" stroke-width="1.5" marker-end="url(#arrow)"/>
  <text x="345" y="94" font-size="11" fill="muted" text-anchor="start">k</text>

  <!-- Averaging Window Highlight -->
  <rect x="110" y="20" width="160" height="80" rx="8" fill="accent-soft" stroke="accent" stroke-width="1.5" stroke-dasharray="4 3"/>
  <text x="190" y="38" font-size="11" fill="accent" text-anchor="middle">Window: 6 samples (M₁=0, M₂=5)</text>

  <!-- Sample Stems outside window -->
  <line x1="50" y1="90" x2="50" y2="70" stroke="muted" stroke-width="1.5"/>
  <circle cx="50" cy="70" r="3" fill="muted"/>

  <line x1="80" y1="90" x2="80" y2="60" stroke="muted" stroke-width="1.5"/>
  <circle cx="80" cy="60" r="3" fill="muted"/>

  <!-- Sample Stems inside window -->
  <line x1="125" y1="90" x2="125" y2="55" stroke="ink" stroke-width="1.5"/>
  <circle cx="125" cy="55" r="3.5" fill="ink"/>
  <text x="125" y="106" font-size="11" fill="ink" text-anchor="middle">n−5</text>

  <line x1="150" y1="90" x2="150" y2="45" stroke="ink" stroke-width="1.5"/>
  <circle cx="150" cy="45" r="3.5" fill="ink"/>

  <line x1="175" y1="90" x2="175" y2="65" stroke="ink" stroke-width="1.5"/>
  <circle cx="175" cy="65" r="3.5" fill="ink"/>

  <line x1="200" y1="90" x2="200" y2="48" stroke="ink" stroke-width="1.5"/>
  <circle cx="200" cy="48" r="3.5" fill="ink"/>

  <line x1="225" y1="90" x2="225" y2="58" stroke="ink" stroke-width="1.5"/>
  <circle cx="225" cy="58" r="3.5" fill="ink"/>

  <line x1="250" y1="90" x2="250" y2="40" stroke="ink" stroke-width="1.5"/>
  <circle cx="250" cy="40" r="3.5" fill="ink"/>
  <text x="250" y="106" font-size="11" fill="ink" text-anchor="middle">n</text>

  <!-- Future Samples -->
  <line x1="295" y1="90" x2="295" y2="70" stroke="muted" stroke-width="1.5"/>
  <circle cx="295" cy="70" r="3" fill="muted"/>
  <text x="295" y="106" font-size="11" fill="muted" text-anchor="middle">n+1</text>
</svg>
```

---

### System Properties

Throughout Sections 2.2.1–2.2.5 (pp. 41–46), the text systematically evaluates the moving-average system against standard structural classifications.

#### 1. Memory (p. 42)
A system is memoryless if $y[n]$ depends only on $x[n]$ at the exact same index. The MA system is **not memoryless** unless $M_1 = M_2 = 0$, in which case it degenerates to the identity system $y[n] = x[n]$.

#### 2. Linearity (p. 42)
\begin{proposition}[Linearity]\label{prop:ma-linearity}
The moving-average system defined in \ref{def:moving-average} is linear.
\end{proposition}

\begin{proof}
Let $x_3[n] = a x_1[n] + b x_2[n]$ for arbitrary scalars $a, b \in \mathbb{C}$. Applying the transformation in \eqref{eq:ma_def}:
\begin{align}
y_3[n] &= \frac{1}{M_1 + M_2 + 1} \sum_{k=-M_1}^{M_2} \Big( a x_1[n-k] + b x_2[n-k] \Big) \label{eq:ma_lin_split} \\
&= a \left( \frac{1}{M_1 + M_2 + 1} \sum_{k=-M_1}^{M_2} x_1[n-k] \right) + b \left( \frac{1}{M_1 + M_2 + 1} \sum_{k=-M_1}^{M_2} x_2[n-k] \right) \label{eq:ma_lin_factor} \\
&= a y_1[n] + b y_2[n] \label{eq:ma_lin_result}
\end{align}
Superposition holds identically for all inputs, establishing linearity.
\end{proof}

#### 3. Time Invariance (p. 43)
\begin{proposition}[Time Invariance]\label{prop:ma-ti}
The moving-average system is time-invariant (shift-invariant).
\end{proposition}

\begin{proof}
Let $x_1[n] = x[n - n_0]$ be a delayed version of $x[n]$. Evaluating the response $y_1[n]$ to $x_1[n]$:
\begin{equation}
y_1[n] = \frac{1}{M_1 + M_2 + 1} \sum_{k=-M_1}^{M_2} x_1[n-k] = \frac{1}{M_1 + M_2 + 1} \sum_{k=-M_1}^{M_2} x[(n - n_0) - k] \label{eq:ma_ti_eval}
\end{equation}
Shifting the original output $y[n]$ by $n_0$ yields:
\begin{equation}
y[n - n_0] = \frac{1}{M_1 + M_2 + 1} \sum_{k=-M_1}^{M_2} x[n - n_0 - k] \label{eq:ma_ti_shift}
\end{equation}
Since \eqref{eq:ma_ti_eval} and \eqref{eq:ma_ti_shift} are identical for all $n$ and $n_0$, $y_1[n] = y[n - n_0]$, verifying time invariance.
\end{proof}

#### 4. Causality (p. 45)
A system is causal if the output $y[n_0]$ depends only on input samples $x[n]$ for $n \le n_0$.
* If $M_1 > 0$, the system accesses future samples $x[n+1], \dots, x[n+M_1]$, rendering it **noncausal**.
* The MA system is causal if and only if $-M_1 \ge 0$ (i.e., $M_1 \le 0$) and $M_2 \ge 0$ (p. 45). The standard causal form sets $M_1 = 0$, averaging the current sample and $M_2$ preceding samples.

#### 5. Stability (p. 46)
\begin{proposition}[BIBO Stability]\label{prop:ma-stability}
The moving-average system is bounded-input, bounded-output (BIBO) stable.
\end{proposition}

\begin{proof}
Assume the input sequence is bounded: $|x[n]| \le B_x < \infty$ for all $n$. Applying the triangle inequality to \eqref{eq:ma_def}:
\begin{align}
|y[n]| &= \left| \frac{1}{M_1 + M_2 + 1} \sum_{k=-M_1}^{M_2} x[n-k] \right| \label{eq:ma_stab_1} \\
&\le \frac{1}{M_1 + M_2 + 1} \sum_{k=-M_1}^{M_2} |x[n-k]| \label{eq:ma_stab_2} \\
&\le \frac{1}{M_1 + M_2 + 1} \sum_{k=-M_1}^{M_2} B_x \label{eq:ma_stab_3} \\
&= \frac{1}{M_1 + M_2 + 1} (M_1 + M_2 + 1) B_x = B_x \label{eq:ma_stab_4}
\end{align}
Choosing $B_y = B_x < \infty$ satisfies the BIBO stability criterion $|y[n]| \le B_y$ for all $n$.
\end{proof}

---

### Impulse Response and Convolution Form

Because the system is both linear (\ref{prop:ma-linearity}) and time-invariant (\ref{prop:ma-ti}), it is an LTI system and is fully characterized by its impulse response $h[n] = T\{\delta[n]\}$ (Section 2.3, p. 47):

\begin{corollary}[Impulse Response]\label{cor:ma-impulse}
Setting $x[n] = \delta[n]$ in \eqref{eq:ma_def} gives:
\begin{equation}
h[n] = \frac{1}{M_1 + M_2 + 1} \sum_{k=-M_1}^{M_2} \delta[n - k] = \begin{cases} \dfrac{1}{M_1 + M_2 + 1}, & -M_1 \le n \le M_2 \\[8pt] 0, & \text{otherwise} \end{cases} \label{eq:ma_impulse_response}
\end{equation}
\end{corollary}

Hence, the moving average is a finite impulse response (FIR) filter with a rectangular window profile, acting as a simple lowpass smoothing filter.
