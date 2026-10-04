import styles from './Layout.module.css';

export default function Logo({ compact }) {
  return (
    <span className={styles.logo}>
      <svg viewBox="0 0 32 32" className={styles.logoMark} aria-hidden="true">
        <path d="M16 4.5 27 10.5v11L16 27.5 5 21.5v-11z" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinejoin="round" />
        <path d="M16 16v11.5M16 16l11-5.5M16 16 5 10.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity=".8" />
        <circle cx="16" cy="16" r="2.4" fill="var(--accent)" />
      </svg>
      {!compact && (
        <span className={styles.logoWord}>
          Web<span>Recon</span>
        </span>
      )}
    </span>
  );
}
