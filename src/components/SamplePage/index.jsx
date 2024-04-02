import React, { useEffect, useState, useRef } from 'react';
import './css/Sample.css';
import { useNavigate, useParams } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';
import Navbar from 'components/Navgbar';

const SamplePage = () => {
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

    const samples = [
        {
            name: "box",
            prefix: "m",
            count: 17,
            suffix: ".png"
        },
        {
            name: "switch",
            prefix: "b",
            count: 18,
            suffix: ".png"
        }
    ]

    useEffect(() => {
        if (authChecked && !authenticated) {
            navigateTo('/login');
        } else if (authChecked && authenticated) {
            loadSamples();
        }
    }, [authChecked, authenticated]);

    const loadSamples = async () => {

    }

    const downloadSample = (sample_name) => {
        const url = `/3dreconstruction/sample/${sample_name}/${sample_name}.zip`;
        const link = document.createElement('a');
        link.href = url;
        link.download = `zipped_sample_${sample_name}.zip`;
        link.click();
    }

    return (
        <>
            <Navbar></Navbar>
            <div id="project-sample" className="project-field">
                {samples.map((sample, sample_index) => (
                    <div key={sample_index} className='project-sample-wrapper'>
                        <div className='project-sample-header'>
                            <div className='project-list-title'>{`Sample ${sample_index + 1}`}</div>
                            <div className="redirect btn" onClick={() => downloadSample(sample.name)}>Download</div>
                        </div>
                        <div className="project-sample-content">
                            {Array.from({ length: sample.count }, (_, i) => (
                                <img key={i} src={`/3dreconstruction/sample/${sample.name}/rgb/${sample.prefix}${i + 1}${sample.suffix}`} alt="" />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </>
    )
};

export default SamplePage;