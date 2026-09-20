\begin{definition}[Contraction]\label{def:contraction}
A map $T: X \to X$ on a metric space is a *contraction* if $d(Tx, Ty) \le q\, d(x, y)$ for some $q < 1$.
\end{definition}

\begin{theorem}[Banach]\label{thm:banach}
Every contraction on a complete metric space has exactly one fixed point.
\end{theorem}

Much later in the chat, the fixed point of $x \mapsto \cos x$ on $[0, 1]$ exists by \ref{thm:banach}, because $\cos$ is a contraction there (see \ref{def:contraction}).
