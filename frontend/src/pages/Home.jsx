import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/index.js';
import { publicAsset } from '../config.js';
import { useAuth } from '../hooks/auth.jsx';
import { useToast } from '../hooks/toast.jsx';
import Icon from '../components/ui/Icon.jsx';
import PointCloudHero from '../components/PointCloudHero.jsx';
import styles from './Home.module.css';

const PIPELINE = [
  { n: '01', title: 'Photos', text: 'A walk-around of 20–80 overlapping shots, or a short video.' },
  { n: '02', title: 'Camera poses', text: 'Features are matched across views to solve where every photo was taken.' },
  { n: '03', title: 'Depth', text: 'Each view gets a per-pixel depth map from its neighbours.' },
  { n: '04', title: 'Point cloud', text: 'Depth maps are back-projected and fused into one dense cloud.' },
  { n: '05', title: 'Textured mesh', text: 'A surface is meshed, cleaned, decimated and painted with photo colour.' },
];

const FEATURES = [
  { icon: 'cube', title: 'Ready-to-use output', text: 'Clean, decimated meshes with baked textures. GLB for the web, OBJ for DCC tools, PLY for analysis, USDZ for AR Quick Look.' },
  { icon: 'sparkle', title: 'Object isolation', text: 'Object mode masks the background so you get the subject, not your kitchen table.' },
  { icon: 'layers', title: 'Quality you choose', text: 'Draft for a quick check, High when you need every detail. Pick texture size and face budget.' },
  { icon: 'terminal', title: 'Live and transparent', text: 'Follow each stage as it runs, with the full pipeline log one click away.' },
];

function SampleCard({ sample, onTry, busy }) {
  const thumb = api.assetUrl(sample.thumbnail_url);
  return (
    <article className={`card ${styles.sample}`}>
      <div className={styles.sampleThumb}>
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <Icon name="image" />}
        <span className={`badge badge--plain ${styles.sampleCount}`}>{sample.image_count} photos</span>
      </div>
      <div className={styles.sampleBody}>
        <h3>{sample.title || sample.name}</h3>
        {sample.description && <p className="muted small">{sample.description}</p>}
        <button type="button" className="btn btn--sm" onClick={() => onTry(sample)} disabled={busy}>
          {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="arrowRight" />}
          Try this sample
        </button>
      </div>
    </article>
  );
}

function Samples() {
  const { status } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [samples, setSamples] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    const ctrl = new AbortController();
    api.samples
      .list({ signal: ctrl.signal })
      .then(setSamples)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => ctrl.abort();
  }, []);

  const tryIt = useCallback(
    async (sample) => {
      if (status !== 'authenticated') {
        navigate(`/login?next=${encodeURIComponent(`/try/${sample.name}`)}`);
        return;
      }
      setBusy(sample.name);
      try {
        const project = await api.samples.createProject(sample.name);
        navigate(`/projects/${project.id}`);
      } catch (err) {
        toast.error('Could not create the sample project', err.message);
        setBusy(null);
      }
    },
    [status, navigate, toast],
  );

  return (
    <section id="samples" className={`container ${styles.section}`} aria-labelledby="samples-title">
      <div className={styles.sectionHead}>
        <span className="eyebrow">Sample sets</span>
        <h2 id="samples-title">No photos handy? Start from a sample.</h2>
        <p className="lead">Each sample creates a project pre-filled with a real capture, ready to reconstruct.</p>
      </div>
      {error && (
        <div className="callout callout--warn" role="status">
          <Icon name="alert" />
          <span>Samples are unavailable right now: {error}</span>
        </div>
      )}
      {!error && (
        <div className={styles.sampleGrid} aria-busy={!samples}>
          {!samples &&
            [0, 1, 2].map((i) => (
              <div key={i} className={`card ${styles.sample}`}>
                <div className={`skeleton ${styles.sampleThumb}`} />
                <div className={styles.sampleBody}>
                  <div className="skeleton skeleton-text" style={{ width: '60%' }} />
                  <div className="skeleton skeleton-text" style={{ width: '90%' }} />
                </div>
              </div>
            ))}
          {samples?.length === 0 && <p className="muted">No samples are installed on this server.</p>}
          {samples?.map((s) => (
            <SampleCard key={s.name} sample={s} onTry={tryIt} busy={busy === s.name} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function Home() {
  const { status } = useAuth();
  const location = useLocation();
  const startHref = status === 'authenticated' ? '/projects' : '/register';

  // Header links ("How it works", "Samples") navigate here with a section to scroll to.
  useEffect(() => {
    const id = location.state?.scrollTo;
    if (!id) return;
    const el = document.getElementById(id);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [location.state, location.key]);

  return (
    <>
      <section className={styles.hero}>
        <div className={`container ${styles.heroInner}`}>
          <div className={styles.heroCopy}>
            <span className="eyebrow">Photogrammetry, in your browser</span>
            <h1>
              Walk around it.
              <br />
              <span className={styles.heroAccent}>Get a 3D model.</span>
            </h1>
            <p className="lead">
              Upload a set of overlapping photos and WebRecon recovers the cameras, estimates depth, fuses a point cloud and
              bakes a clean, textured mesh you can drop into Blender, a game engine, or AR.
            </p>
            <div className="row" style={{ '--gap': '12px' }}>
              <Link to={startHref} className="btn btn--primary btn--lg">
                Start a project <Icon name="arrowRight" />
              </Link>
              <Link to="/" state={{ scrollTo: 'samples' }} className="btn btn--lg">
                Try a sample
              </Link>
            </div>
            <dl className={styles.specs}>
              <div>
                <dt>Input</dt>
                <dd>JPG · PNG · HEIC · MP4</dd>
              </div>
              <div>
                <dt>Output</dt>
                <dd>GLB · OBJ · PLY · USDZ</dd>
              </div>
              <div>
                <dt>Sweet spot</dt>
                <dd>20–80 photos</dd>
              </div>
            </dl>
          </div>
          <figure className={`frame ${styles.heroFigure}`}>
            <PointCloudHero className={styles.heroCanvas} />
            <figcaption className={styles.caption}>
              <span>fig. 1</span> dense cloud from 9 views · scan plane = fusion progress
            </figcaption>
          </figure>
        </div>
      </section>

      <section className={`container ${styles.section}`} aria-labelledby="pipeline-title">
        <div className={styles.sectionHead}>
          <span className="eyebrow">The pipeline</span>
          <h2 id="pipeline-title">From pixels to a printable surface</h2>
        </div>
        <ol className={styles.pipeline}>
          {PIPELINE.map((s) => (
            <li key={s.n}>
              <span className={styles.pipeNum}>{s.n}</span>
              <h3>{s.title}</h3>
              <p className="muted small">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="how" className={`container ${styles.section}`} aria-labelledby="how-title">
        <div className={styles.sectionHead}>
          <span className="eyebrow">How it works</span>
          <h2 id="how-title">Depth turns a pixel into a point</h2>
          <p className="lead">
            A photo is a 2D projection of the world: the depth of every pixel is lost. Recover that depth, and each pixel
            can be lifted back into 3D. Do it from many viewpoints and the points add up to a surface.
          </p>
        </div>
        <div className={styles.principles}>
          <article className={styles.principle}>
            <figure className={styles.principleFig}>
              <img src={publicAsset('image/principle_showcase.png')} alt="A photo of a box with one pixel's coordinates (324, 241) marked by crosshair lines" loading="lazy" />
            </figure>
            <div>
              <span className={styles.pnum}>A</span>
              <h3>Every pixel has an address</h3>
              <p className="muted">
                A pixel is a pair of coordinates <code>(u, v)</code>, here <code>(324, 241)</code>. On its own it only tells us
                the direction of a ray leaving the camera, not how far along that ray the surface is.
              </p>
            </div>
          </article>
          <article className={styles.principle}>
            <figure className={styles.principleFig}>
              <img src={publicAsset('image/depth_showcase.png')} alt="Rays from a camera to the corners of a box, with the maximum depth marked" loading="lazy" />
            </figure>
            <div>
              <span className={styles.pnum}>B</span>
              <h3>Depth from overlapping views</h3>
              <p className="muted">
                When the same point appears in two or more photos taken from known positions, its distance <code>d</code> can be
                triangulated. Dense matching repeats this for every pixel to build a depth map per view.
              </p>
            </div>
          </article>
          <article className={styles.principle}>
            <figure className={`${styles.principleFig} ${styles.formulaFig}`}>
              <div className={styles.formula} aria-label="X equals d times K inverse times the vector u, v, 1">
                <span>X</span> = <span>d</span> · <span className={styles.kinv}>K<sup>−1</sup></span>
                <span className={styles.vec}>
                  <span>u</span>
                  <span>v</span>
                  <span>1</span>
                </span>
              </div>
              <p className="mono small muted">K = camera intrinsics (focal length, principal point)</p>
            </figure>
            <div>
              <span className={styles.pnum}>C</span>
              <h3>Back-project, fuse, mesh</h3>
              <p className="muted">
                With the camera intrinsics <code>K</code> and pose, each pixel and its depth becomes a 3D point. Points from all
                views are fused into one cloud, then a surface is fitted, cleaned and textured from the original photos.
              </p>
            </div>
          </article>
          <article className={styles.principle}>
            <figure className={styles.principleFig}>
              <img src={publicAsset('image/focal_length_showcase.jpg')} alt="The same landscape shot at focal lengths from 18mm to 300mm" loading="lazy" />
            </figure>
            <div>
              <span className={styles.pnum}>D</span>
              <h3>Why a fixed zoom helps</h3>
              <p className="muted">
                Focal length is part of <code>K</code>. Zooming between shots changes it, so the solver has more unknowns to
                estimate. Keep the zoom fixed and let your feet do the framing.
              </p>
            </div>
          </article>
        </div>
      </section>

      <Samples />

      <section className={`container ${styles.section}`} aria-labelledby="features-title">
        <div className={styles.sectionHead}>
          <span className="eyebrow">What you get</span>
          <h2 id="features-title">Models that are ready to use, not just to look at</h2>
        </div>
        <div className={styles.features}>
          {FEATURES.map((f) => (
            <div key={f.title} className={styles.feature}>
              <Icon name={f.icon} className={styles.featureIcon} />
              <h3>{f.title}</h3>
              <p className="muted small">{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="container">
        <div className={styles.cta}>
          <div>
            <h2>Got something on your desk?</h2>
            <p>Grab your phone, take 30 photos while walking around it, and see it in 3D in a few minutes.</p>
          </div>
          <Link to={startHref} className="btn btn--primary btn--lg">
            Start a project <Icon name="arrowRight" />
          </Link>
        </div>
      </section>
    </>
  );
}
