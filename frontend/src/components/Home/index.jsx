import React, { useEffect, useState, useRef } from 'react';
import './css/Home.css';
import { useNavigate } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';
import Navbar from 'components/Navgbar';

const Main = () => {
    const {
        authenticated,
        setAuthenticated,
        userData,
        setUserData,
        updateUserData,
        authChecked,
        setAuthChecked,
        controllerRef
    } = useSocket();

    const navigateTo = useNavigate();

    const getStarted = () => {
        if (!authenticated)
            navigateTo('/login');
        else {
            navigateTo('/projects');
        }
    }

    const learnMore = () => {
        // navigateTo('/howitworks');
    }

    return (
        <>
            <Navbar></Navbar>
            <div className='home-container'>
                <div className="home-hero">
                    <div className="heroContainer home-hero1">
                        <div className="home-container01">
                            <h1 className="home-hero-heading heading1">
                                Transforming Images into 3D Point Clouds
                            </h1>
                            <span className="home-hero-sub-heading bodyLarge">
                                Simplifying the way you create models through image reconstruction
                            </span>
                            <div className="home-btn-group">
                                <div className="btn buttonFilled" onClick={getStarted}>Get Started</div>
                                <div className="btn buttonFlat" onClick={getStarted}>Learn More →</div>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="home-features">
                    <div className="featuresContainer">
                        <div className="home-features1">
                            <div className="home-container02">
                                <span className="overline">
                                    <span>features</span>
                                    <br></br>
                                </span>
                                <h2 className="home-features-heading heading2">
                                    Multi-View Stereo + ICP Registration
                                </h2>
                                <span className="home-features-sub-heading bodyLarge">
                                    Explore the capabilities that make our image to 3D
                                    reconstruction tool stand out
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="home-pricing">
                    <div className="pricingContainer">
                        <div className="home-container04">
                            <span className="overline">
                                <span>Project Overview</span>
                                <br></br>
                            </span>
                            <h2 className="heading2">Coarse 3D Point Cloud Reconstruction</h2>
                            <span className="home-pricing-sub-heading bodyLarge">
                                <span>
                                    <span>
                                        Discover what makes our project unique and innovative
                                    </span>
                                </span>
                            </span>
                        </div>
                        <div className="home-container05">
                            <div className="freePricingCard home-pricing-card">
                                <div className="home-container06">
                                    <span className="home-text36 heading3">Image-Based Modeling</span>
                                    <span className="bodySmall">
                                        <p>This project leverages the power of Python for image processing and 3D reconstruction.</p>
                                        <p>Python's extensive libraries and tools for image processing and machine learning are used to generate point clouds from images and reconstruct 3D models from these point clouds.</p>
                                        <p>The Python scripts are integrated with a Node.js server, enabling the deployment of the complex image processing logic on a web platform.</p>
                                    </span>
                                </div>
                                <div className="home-container07">
                                    <span className="home-text37">
                                        <span className="home-text38">✔</span>
                                        <span className="bodySmall"> Point cloud reconstruction from images</span>
                                    </span>
                                    <span className="home-text37">
                                        <span className="home-text38">✔</span>
                                        <span className="bodySmall"> Python and Node.js integration for web deployment</span>
                                    </span>
                                </div>
                            </div>
                            <div className="freePricingCard home-pricing-card">
                                <div className="home-container06">
                                    <span className="home-text36 heading3">Full Stack Integration</span>
                                    <span className="bodySmall">
                                        <p>This project showcases a seamless integration of various technologies to build a full stack application.</p>
                                        <p>The front-end, built with React, provides a dynamic and interactive user interface. It communicates with the back-end server, built with Node.js, to send user requests and receive responses.</p>
                                        <p>The back-end server not only handles these requests but also interacts with a MongoDB database for data storage and retrieval. Amazon S3 is utilized for secure and reliable storage of images used in the 3D reconstruction process.</p>
                                    </span>
                                </div>
                                <div className="home-container07">
                                    <span className="home-text37">
                                        <span className="home-text38">✔</span>
                                        <span className="bodySmall"> Seamless integration of front-end and back-end technologies</span>
                                    </span>
                                    <span className="home-text37">
                                        <span className="home-text38">✔</span>
                                        <span className="bodySmall"> Efficient data handling with MongoDB</span>
                                    </span>
                                    <span className="home-text37">
                                        <span className="home-text38">✔</span>
                                        <span className="bodySmall"> Secure image storage with Amazon S3</span>
                                    </span>
                                </div>
                            </div>
                            <div className="basicPricingCard home-pricing-card1">
                                <div className="home-container12">
                                    <span className="home-text43 heading3">3D Visualization with Three.js</span>
                                    <span className="bodySmall">
                                        <p>Three.js is used for the visualization of the reconstructed 3D point cloud.</p>
                                        <p>This powerful library allows for real-time rendering of 3D models in the browser, providing an interactive and immersive user experience.</p>
                                        <p>The 3D models can be manipulated and analyzed directly in the application, providing valuable insights into the reconstruction process.</p>
                                    </span>
                                </div>
                                <div className="home-container07">
                                    <span className="home-text37">
                                        <span className="home-text38">✔</span>
                                        <span className="bodySmall"> Interactive 3D visualization tools for in-depth analysis</span>
                                    </span>
                                    <span className="home-text37">
                                        <span className="home-text38">✔</span>
                                        <span className="bodySmall"> Real-time rendering of 3D models for immediate feedback</span>
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="home-banner">
                    <div className="bannerContainer home-banner1">
                        <h1 className="home-banner-heading heading2">
                            Experience the Future of Image Reconstruction
                        </h1>
                        <span className="home-banner-sub-heading bodySmall">
                            <div>Our innovative approach transforms 2D images into detailed 3D point cloud models, adding a new dimension to your visuals.</div>
                            <div>Through sophisticated Python algorithms and the immersive capabilities of Three.js, we ensure precise and immersive 3D reconstructions.</div>
                        </span>
                        <div className="btn buttonFilled" onClick={getStarted}>Learn More</div>
                    </div>
                </div>
                <div className="home-footer">
                    <footer className="footerContainer home-footer1">
                        <div className="home-container30">
                            <span className="logo">RECONSTRUCT</span>
                            <nav className="home-nav1">
                                <span className="pointer bodySmall" onClick={() => navigateTo("/")}>Home</span>                                
                                <span className="pointer home-nav322 bodySmall" onClick={() => navigateTo("/samples")}>Samples</span>
                                <span className="pointer home-nav422 bodySmall" onClick={() => window.open("https://github.com/InvokFung/3dreconstruction-api")}>Github</span>
                                <span className="pointer home-nav522 bodySmall" onClick={() => window.scrollTo(0, 0)}>Go to Top</span>
                            </nav>
                        </div>
                        <div className="home-separator"></div>
                        <div className="home-container31">
                            <span className="bodySmall home-text88">
                                © 2024 Fung Kwan Tai, All Rights Reserved.
                            </span>
                            <div className="home-icon-group1">
                                <svg
                                    viewBox="0 0 950.8571428571428 1024"
                                    className="home-icon10 socialIcons pointer"
                                >
                                    <path d="M925.714 233.143c-25.143 36.571-56.571 69.143-92.571 95.429 0.571 8 0.571 16 0.571 24 0 244-185.714 525.143-525.143 525.143-104.571 0-201.714-30.286-283.429-82.857 14.857 1.714 29.143 2.286 44.571 2.286 86.286 0 165.714-29.143 229.143-78.857-81.143-1.714-149.143-54.857-172.571-128 11.429 1.714 22.857 2.857 34.857 2.857 16.571 0 33.143-2.286 48.571-6.286-84.571-17.143-148-91.429-148-181.143v-2.286c24.571 13.714 53.143 22.286 83.429 23.429-49.714-33.143-82.286-89.714-82.286-153.714 0-34.286 9.143-65.714 25.143-93.143 90.857 112 227.429 185.143 380.571 193.143-2.857-13.714-4.571-28-4.571-42.286 0-101.714 82.286-184.571 184.571-184.571 53.143 0 101.143 22.286 134.857 58.286 41.714-8 81.714-23.429 117.143-44.571-13.714 42.857-42.857 78.857-81.143 101.714 37.143-4 73.143-14.286 106.286-28.571z"></path>
                                </svg>
                                <svg
                                    viewBox="0 0 877.7142857142857 1024"
                                    className="home-icon12 socialIcons pointer"
                                >
                                    <path d="M585.143 512c0-80.571-65.714-146.286-146.286-146.286s-146.286 65.714-146.286 146.286 65.714 146.286 146.286 146.286 146.286-65.714 146.286-146.286zM664 512c0 124.571-100.571 225.143-225.143 225.143s-225.143-100.571-225.143-225.143 100.571-225.143 225.143-225.143 225.143 100.571 225.143 225.143zM725.714 277.714c0 29.143-23.429 52.571-52.571 52.571s-52.571-23.429-52.571-52.571 23.429-52.571 52.571-52.571 52.571 23.429 52.571 52.571zM438.857 152c-64 0-201.143-5.143-258.857 17.714-20 8-34.857 17.714-50.286 33.143s-25.143 30.286-33.143 50.286c-22.857 57.714-17.714 194.857-17.714 258.857s-5.143 201.143 17.714 258.857c8 20 17.714 34.857 33.143 50.286s30.286 25.143 50.286 33.143c57.714 22.857 194.857 17.714 258.857 17.714s201.143 5.143 258.857-17.714c20-8 34.857-17.714 50.286-33.143s25.143-30.286 33.143-50.286c22.857-57.714 17.714-194.857 17.714-258.857s5.143-201.143-17.714-258.857c-8-20-17.714-34.857-33.143-50.286s-30.286-25.143-50.286-33.143c-57.714-22.857-194.857-17.714-258.857-17.714zM877.714 512c0 60.571 0.571 120.571-2.857 181.143-3.429 70.286-19.429 132.571-70.857 184s-113.714 67.429-184 70.857c-60.571 3.429-120.571 2.857-181.143 2.857s-120.571 0.571-181.143-2.857c-70.286-3.429-132.571-19.429-184-70.857s-67.429-113.714-70.857-184c-3.429-60.571-2.857-120.571-2.857-181.143s-0.571-120.571 2.857-181.143c3.429-70.286 19.429-132.571 70.857-184s113.714-67.429 184-70.857c60.571-3.429 120.571-2.857 181.143-2.857s120.571-0.571 181.143 2.857c70.286 3.429 132.571 19.429 184 70.857s67.429 113.714 70.857 184c3.429 60.571 2.857 120.571 2.857 181.143z"></path>
                                </svg>
                                <svg
                                    viewBox="0 0 602.2582857142856 1024"
                                    className="home-icon14 socialIcons pointer"
                                >
                                    <path d="M548 6.857v150.857h-89.714c-70.286 0-83.429 33.714-83.429 82.286v108h167.429l-22.286 169.143h-145.143v433.714h-174.857v-433.714h-145.714v-169.143h145.714v-124.571c0-144.571 88.571-223.429 217.714-223.429 61.714 0 114.857 4.571 130.286 6.857z"></path>
                                </svg>
                            </div>
                        </div>
                    </footer>
                </div>
            </div>
        </>
    )
};

export default Main;