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

    const [isSubmitting, setIsSubmitting] = useState(false);

    const gotoNextStage = async () => {
        setIsSubmitting(true);

        if (controllerRef.current)
            controllerRef.current.abort();

        controllerRef.current = new AbortController();

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
            const projectUrl = `http://localhost:3000/projectConfig`;
            const response = await fetch(projectUrl, {
                method: "POST",
                body: formData,
                signal: controllerRef.current.signal
            });
            const data = await response.json();
            if (data.status === 200) {
                setStage(3);
            } else {
                alert('Failed to load projects');
            }
        } catch (error) {
            console.log(error);
            setIsSubmitting(false);
        }
    }

    // =============================================================

    return (
        <>
            <div id="project-preset" className="project-field">
                <div className='project-header'>
                    <span>Step 2. Configure Parameters (Optional)</span>
                    <div id="upload-guide" className="guide" title="View Guideline">?</div>
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
                    <div id="next-btn" className="btn buttonFilled" onClick={gotoNextStage} disabled={isSubmitting}>Next</div>
                </div>
            </div>
        </>
    )
};

export default ProjectConfig;