# The Fast Fourier Transform (FFT)

The paper mentions the FFT at `paper.txt:9444`. Its claim is that the FFT turns the $O(n^2)$ Cauchy product into $O(n \log n)$ pointwise multiplications, using the Convolution Theorem.

## The idea

You can describe a polynomial of degree less than $n$ in two equivalent ways:

- **By its coefficients:** $(a_0, a_1, \dots, a_{n-1})$.
- **By its values:** $A(z_0), \dots, A(z_{n-1})$ at $n$ fixed points. Those $n$ values pin down the polynomial exactly.

Multiplying is slow with coefficients. The Cauchy product $c_k = \sum_i a_i b_{k-i}$ multiplies every term by every other term, which costs $O(n^2)$. With values it is fast: $C(z) = A(z)\,B(z)$ point by point costs $O(n)$.

So the method has three steps: convert coefficients to values, multiply the values pointwise, then convert back. The catch is the conversion. At arbitrary points it costs $O(n^2)$ each way, so nothing is gained. The FFT gets it down to $O(n \log n)$ by always using the same special points: the **$n$-th roots of unity**.

## Why roots of unity

Let $\omega = e^{2\pi i/n}$ with $n$ a power of 2. The points $1, \omega, \omega^2, \dots, \omega^{n-1}$ sit evenly spaced on the unit circle. The key property is that **squaring halves the set**. Since $\omega^{n/2} = -1$, the points $\omega^j$ and $-\omega^j$ have the same square:

$$\left(\pm\,\omega^j\right)^2 = \omega^{2j},$$

and the $n$ squares are exactly the $(n/2)$-th roots of unity, each appearing twice. For example, the 8 eighth roots square to the 4 fourth roots.

## The formal statements

**Discrete Fourier Transform (DFT).** The DFT evaluates $A$ at the roots of unity:

$$\hat{A}_j = A(\omega^j) = \sum_{k=0}^{n-1} a_k\, \omega^{jk}, \qquad j = 0, \dots, n-1.$$

**Inverse.** The inverse has the same form, with $\omega^{-1}$ in place of $\omega$ and an extra factor $1/n$:

$$a_k = \frac{1}{n} \sum_{j=0}^{n-1} \hat{A}_j\, \omega^{-jk}.$$

This works because of the orthogonality relation

$$\sum_{j=0}^{n-1} \omega^{jm} = \begin{cases} n & m \equiv 0 \pmod n \\ 0 & \text{otherwise.} \end{cases}$$

**Convolution Theorem.** The transform of a convolution is the pointwise product of the transforms:

$$\widehat{(a * b)}_j = \hat{A}_j \cdot \hat{B}_j.$$

## The FFT: computing the DFT recursively

Split $A$ into its even and odd coefficients:

$$A(z) = A_{\text{even}}(z^2) + z\, A_{\text{odd}}(z^2).$$

$A_{\text{even}}$ and $A_{\text{odd}}$ each have $n/2$ coefficients. They are evaluated at $z^2$, and by the squaring property only the $n/2$ points $\omega^{2j}$ are needed. So:

1. Recursively evaluate $A_{\text{even}}$ and $A_{\text{odd}}$ at the $(n/2)$-th roots of unity.
2. Combine the results for all $n$ points in $O(n)$:
$$A(\pm\,\omega^j) = A_{\text{even}}(\omega^{2j}) \pm \omega^j A_{\text{odd}}(\omega^{2j}).$$

This gives the cost

$$T(n) = 2\,T(n/2) + O(n) \;\Longrightarrow\; T(n) = O(n \log n).$$

The inverse runs the same algorithm with $\omega^{-1}$, then divides by $n$.

**Multiplying $A$ and $B$ end to end:**
1. Pick $n$ as a power of 2 with $n \ge \deg A + \deg B + 1$, so the product fits.
2. Apply the FFT to $A$ and to $B$: $O(n \log n)$.
3. Multiply pointwise, $\hat{C}_j = \hat{A}_j \hat{B}_j$: $O(n)$.
4. Apply the inverse FFT to get the coefficients of $C$: $O(n \log n)$.

## Worked example

Take $A = 1 + 2z$ and $B = 3 + z$. The product has degree 2, so $n = 4$ and the points are $1, i, -1, -i$.

| $z$ | $A(z)$ | $B(z)$ | $\hat{C} = A\,B$ |
|---|---|---|---|
| $1$ | $3$ | $4$ | $12$ |
| $i$ | $1+2i$ | $3+i$ | $1+7i$ |
| $-1$ | $-1$ | $2$ | $-2$ |
| $-i$ | $1-2i$ | $3-i$ | $1-7i$ |

Now apply the inverse with $\omega = i$ and $\omega^{-1} = -i$:

$$c_0 = \tfrac{1}{4}\big(12 + (1+7i) - 2 + (1-7i)\big) = 3$$

$$c_1 = \tfrac{1}{4}\big(12 + (1+7i)(-i) + (-2)(-1) + (1-7i)(i)\big) = \tfrac{1}{4}(12 + 7 - i + 2 + 7 + i) = 7$$

$$c_2 = \tfrac{1}{4}\big(12 - (1+7i) - 2 - (1-7i)\big) = 2, \qquad c_3 = 0$$

So $C = 3 + 7z + 2z^2$, which is exactly $(1+2z)(3+z)$.

**Counterexample.** Evaluate at $0, 1, 2, 3$ instead. The squares are $0, 1, 4, 9$, which don't collapse into a smaller set. The recursion has nothing to split on, and the conversion falls back to $O(n^2)$.

## Link to the paper

A CNN feature map, or the filter $\bar{K}_k = C\bar{A}^k\bar{B}$ in state space models, is a Cauchy product. The FFT computes it in $O(n \log n)$ rather than $O(n^2)$ for long signals. In practice, CNN libraries switch to FFT-based convolution only when kernels are large. For small kernels like $3 \times 3$, the direct sum is faster.

## Background you need

- Complex numbers in polar form, and Euler's formula $e^{i\theta} = \cos\theta + i\sin\theta$
- Roots of unity and finite geometric sums
- The fact that $n$ values determine a polynomial of degree less than $n$ (interpolation)
- The Cauchy product as a convolution (the section just before this one in the paper)
- Divide-and-conquer recurrences and the master theorem