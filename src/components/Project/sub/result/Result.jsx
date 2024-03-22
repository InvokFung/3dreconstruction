import React, { useEffect, useState, useRef } from 'react';

import { useNavigate, useParams } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';

import Scene from "app/scene"

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";


const Result = ({ projectData }) => {

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

    useEffect(() => {
        if (authChecked && authenticated) {
            fetchResult();
        }

        return () => {
            if (sceneRef.current) {
                sceneRef.current.dispose();
                sceneRef.current = null;
            }
        }
    }, [authChecked, authenticated]);

    const mainContainer = useRef();
    const resultField = useRef();

    const sceneRef = useRef(null);

    const [error, setError] = useState(false);
    const [result, setResult] = useState(null);
    const [downloadUrl, setDownloadUrl] = useState(null);
    const [resultRetrieved, setResultRetrieved] = useState(false);

    const s3Downloadv3 = async () => {

        const s3client = new S3Client({
            region: import.meta.env.VITE_AWS_REGION,
            credentials: {
                accessKeyId: import.meta.env.VITE_AWS_ACCESS_KEY_ID,
                secretAccessKey: import.meta.env.VITE_AWS_SECRET_ACCESS_KEY,
            }
        });

        const userId = userData.userId;

        const userResultPath = `user-${userId}/${projectId}/output/accumulated_numpy.npy`;

        const params = {
            Bucket: import.meta.env.VITE_AWS_BUCKET_NAME,
            Key: userResultPath,
        }
        const data = await s3client.send(new GetObjectCommand(params));

        const bodyStream = data.Body;
        const bodyAsString = await bodyStream.transformToByteArray();

        console.log(bodyAsString.buffer)

        return bodyAsString.buffer;

    }

    const fetchResult = async () => {

        console.log("Fetching result...")

        try {
            let result = await s3Downloadv3();
            let arrayBuffer = result;
            setResultRetrieved(true);
            setResult(arrayBuffer);

            console.log("Result fetched.")
        } catch (error) {
            if (error.name === 'NoSuchKey') {
                console.log("File not found:", error);
                setError(true);
            } else {
                console.log("Error getting file:", error);
            }
        }
    }

    const downloadResult = (type) => {
        var link = document.createElement('a');
        if (type === "npy") {
            link.href = downloadUrl.npyUrl;
            link.download = 'result.npy';
        } else if (type === "gltf") {
            link.href = downloadUrl.gltfUrl;
            link.download = 'result.gltf';
        }
        link.click();
    }

    const waitResult = async () => {
        console.log("Creating scene...")
        sceneRef.current = new Scene(resultField.current);
        sceneRef.current.init();
        const [gltfUrl, npyUrl] = await sceneRef.current.loadResult(result);
        setDownloadUrl({ gltfUrl, npyUrl });
    }

    useEffect(() => {
        if (resultRetrieved && !error && sceneRef.current == null && status != "idle") {
            waitResult();
        }
    }, [resultRetrieved])

    // =============================================================

    return (
        <>
            <div id="project-result" className='background-field'>
                <h4>Result Viewport</h4>
                {!error ? (
                    <div ref={mainContainer} className='rcs-container'>
                        {resultRetrieved ? (
                            <div className='result-field' ref={resultField}></div>
                        ) : (
                            <div className='result-field'>
                                <span>Retrieving Model...</span>
                                <span>Please be patient.</span>
                            </div>
                        )}
                        <div className='option-field'>
                            {downloadUrl && (
                                <>
                                    <button onClick={() => downloadResult("npy")}>Download npy</button>
                                    <button onClick={() => downloadResult("gltf")}>Download glTF</button>
                                </>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className='result-field'>
                        <p>There is an error occured during reconstruction.</p>
                        <p>Please go to [Overview] and restart the process.</p>
                    </div>

                )}
            </div>
        </>
    )
};

export default Result;