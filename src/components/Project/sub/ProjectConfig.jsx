import React, { useEffect, useState, useRef } from 'react';

import { useNavigate, useParams } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';


const ProjectConfig = ({ props }) => {
    const {
        stage,
        setStage,
        page,
        setPage,
    } = props;

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

    const { projectId } = useParams();
    const navigateTo = useNavigate();

    const depthMinVal = useRef();
    const depthMaxVal = useRef();
    const fxVal = useRef();
    const fyVal = useRef();
    const cxVal = useRef();
    const cyVal = useRef();

    const configController = useRef();

    const [openGuide, setOpenGuide] = useState(false);
    const [nextBtnContent, setNextBtnContent] = useState("Next");

    let isSubmitting = false;

    const gotoPreviousStage = async () => {
        if (isSubmitting) {
            console.log("Already submitting")
            return;
        }
        isSubmitting = true;

        if (configController.current)
            configController.current.abort();

        configController.current = new AbortController();

        const userId = userData.userId;

        const formData = new FormData();
        formData.append('userId', userId);
        formData.append('projectId', projectId);
        formData.append('action', "status");

        formData.append('status', "idle");

        try {
            const backendURL = import.meta.env.VITE_BACKEND_URL;
            const projectUrl = `${backendURL}/projectUpdate`;
            const response = await fetch(projectUrl, {
                method: "POST",
                body: formData,
                signal: configController.current.signal
            });
            const data = await response.json();
            if (data.status === 200) {
                setStage(1);
            } else {
                alert('Failed to load projects');
            }
        } catch (error) {
            console.log(error);
            isSubmitting = false;
        }
    }

    const gotoNextStage = async () => {
        if (isSubmitting) {
            console.log("Already submitting")
            return;
        }
        isSubmitting = true;
        setNextBtnContent("Saving...");

        if (configController.current)
            configController.current.abort();

        configController.current = new AbortController();

        const userId = userData.userId;

        const formData = new FormData();
        formData.append('userId', userId);
        formData.append('projectId', projectId);

        // Add extra parameters
        const configs = {
            depthMin: Number(depthMinVal.current.value),
            depthMax: Number(depthMaxVal.current.value),
            fx: Number(fxVal.current.value),
            fy: Number(fyVal.current.value),
            cx: Number(cxVal.current.value),
            cy: Number(cyVal.current.value)
        };

        // Convert parameters to JSON string
        const configJSON = JSON.stringify(configs);

        // Append parameters to formData
        formData.append('config', configJSON);


        try {
            const backendURL = import.meta.env.VITE_BACKEND_URL;
            const projectUrl = `${backendURL}/projectConfig`;
            const response = await fetch(projectUrl, {
                method: "POST",
                body: formData,
                signal: configController.current.signal
            });
            const data = await response.json();
            if (data.status === 200) {
                setStage(3);
            } else {
                alert('Failed to load projects');
            }
        } catch (error) {
            console.log(error);
            isSubmitting = false;
            setNextBtnContent("Saving...");
        }
    }

    // =============================================================

    return (
        <>
            <div id="project-preset" className="project-field">
                <div className='project-header'>
                    <span>Step 2. Configure Parameters (Optional)</span>
                    <div id="upload-guide" className="guide" title="View Guideline" onClick={() => setOpenGuide(true)}>?</div>
                </div>

                <div className='preset-form'>
                    <div className='rcs-parameter'>
                        <div className='rp-content'>
                            <div className='rp-item'>
                                <div>Object Depth</div>
                                <div className='multiInput'>
                                    <div className='halfText'>
                                        <label>min</label>
                                        <input className='halfInput' type='number' step="0.01" ref={depthMinVal} defaultValue={0} />
                                    </div>
                                    <div className='halfText'>
                                        <label>max</label>
                                        <input className='halfInput' type='number' step="0.01" ref={depthMaxVal} defaultValue={0} />
                                    </div>
                                </div>
                            </div>
                            <div className='rp-item'>
                                <div>Camera focal length</div>
                                <div className='multiInput'>
                                    <div className='halfText'>
                                        <label>fx</label>
                                        <input className='halfInput' type='number' step="0.01" ref={fxVal} defaultValue={0} />
                                    </div>
                                    <div className='halfText'>
                                        <label>fy</label>
                                        <input className='halfInput' type='number' step="0.01" ref={fyVal} defaultValue={0} />
                                    </div>
                                </div>
                            </div>
                            <div className='rp-item'>
                                <div>Image center position</div>
                                <div className='multiInput'>
                                    <div className='halfText'>
                                        <label>cx</label>
                                        <input className='halfInput' type='number' step="0.01" ref={cxVal} defaultValue={0} />
                                    </div>
                                    <div className='halfText'>
                                        <label>cy</label>
                                        <input className='halfInput' type='number' step="0.01" ref={cyVal} defaultValue={0} />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="submit-field">
                    <div id="return-btn" className="btn buttonFlat" onClick={gotoPreviousStage} >Return</div>
                    <div id="next-btn" className="btn buttonFilled" onClick={gotoNextStage} >{nextBtnContent}</div>
                </div>
            </div>
            {openGuide && (
                <div className='guide-wrapper' onClick={() => setOpenGuide(false)}>
                    <div className='guide-container' onClick={(e) => e.stopPropagation()}>
                        <div className='guide-header'>
                            <span>Configuring Guideline</span>
                            <div
                                className='guide-close pointer'
                                onClick={() => setOpenGuide(false)}
                            >
                                &#10060;
                            </div>
                        </div>
                        <div className='guide-content'>
                            <div>
                                <div>1. If you're unsure about your camera's intrinsic and extrinsic parameters, feel free to skip for now.</div>
                                <div>You can always fine-tune these settings in your next attempt.</div>
                            </div>
                            <hr />
                            <div>2. Fine-tuning your settings</div>
                            <div>
                                <div><strong>- What is object depth? -</strong></div>
                                <div>
                                    <img id="depth_showcase" src="/3dreconstruction/image/depth_showcase.png" title="Object depth showcase" />
                                    <div>Object depth refers to the distance between the camera and the object in the scene.</div>
                                    <div>Depth Min = Depth Max - Object depth</div>
                                    <div>A well configured depth min and max can effectively address the coarseness of the result point cloud.</div>
                                </div>
                            </div>
                            <hr />
                            <div>
                                <div><strong>- What is focal length and how do i find it? -</strong></div>
                                <div>The focal length of a camera lens refers to the distance between the lens and the image sensor.</div>
                                <div>It's usually stated in millimeters (mm). You need to multiply the value by 10 before use.</div>
                                <div>Example:</div>
                                <div>Samsung Galaxy Note 10+ Default camera focal length = 52mm</div>
                                <div>fx = fy = 520</div>
                                <div>
                                    <img id="fl_showcase" src="/3dreconstruction/image/focal_length_showcase.jpg" title="Focal length showcase" />
                                </div>
                                <div>The longer the focal length, the narrower the angle of view and the higher the magnification.
                                </div>
                            </div>
                            <hr />
                            <div>
                                <div><strong>- What is Image center? -</strong></div>
                                <div>The image center, also known as the principal point, is the point in the image where the principal ray (the ray from the scene point through the optical center of the lens) intersects the image plane.</div>
                                <div>
                                    <div>Example:</div>
                                    <img id="cp_showcase" src="/3dreconstruction/image/principle_showcase.png" title="Principle point showcase" />
                                    <div>Image width = 640,  height = 480</div>
                                    <div>cx = 324, cy = 241</div>
                                </div>
                                <div>By default, the cx and cy will be half the image width and height.</div>
                                <div>If you want to adjust the center point of your object in the images, you may configure here.</div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    )
};

export default ProjectConfig;